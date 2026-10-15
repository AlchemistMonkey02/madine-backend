const crypto = require('crypto');
const express = require('express');
const { asyncRouter } = require('./http');
const { rateLimit } = require('express-rate-limit');
const { sendOtpEmail } = require('./mailer');
const { selfProfile } = require('./profile');

const OTP_TTL_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_SENDS_PER_HOUR = 5;
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000; // slide the expiry at most once a day
const COOKIE_NAME = 'vybe_sid';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashOtp = (email, code) => sha256(`${email}:${code}`);
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

function readCookie(req, name) {
  return readCookieHeader(req.headers.cookie, name);
}

function readCookieHeader(header = '', name) {
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
    }
  }
  return null;
}

async function setupAuth(app, db, { isProd }) {
  const users = db.collection('users');
  const otps = db.collection('otps');
  const sessions = db.collection('sessions');

  await Promise.all([
    users.createIndex({ email: 1 }, { unique: true }),
    otps.createIndex({ email: 1 }, { unique: true }),
    otps.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);

  const isCrossDomain = Boolean(
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    process.env.CORS_ORIGIN ||
    process.env.CROSS_DOMAIN_COOKIES === 'true'
  );
  const cookieOpts = {
    httpOnly: true,
    secure: isProd,
    sameSite: (isCrossDomain && isProd) ? 'none' : 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS,
  };

  // Resolves a raw session token to { session, user }, or null. Shared by the
  // HTTP middleware below and the chat socket handshake.
  async function resolveToken(token) {
    if (!token) return null;
    const session = await sessions.findOne({ tokenHash: sha256(token) });
    if (!session || session.expiresAt < new Date()) return null;
    const user = await users.findOne({ _id: session.userId });
    return user ? { session, user } : null;
  }

  // Attaches req.user / req.session when a valid session cookie is present.
  async function loadSession(req, res, next) {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) return next();
    try {
      const found = await resolveToken(token);
      if (!found) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        return next();
      }
      const { session, user } = found;
      if (Date.now() - session.refreshedAt.getTime() > SESSION_REFRESH_MS) {
        const now = new Date();
        await sessions.updateOne({ _id: session._id }, { $set: { refreshedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } });
        res.cookie(COOKIE_NAME, token, cookieOpts);
      }
      req.user = user;
      req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  }

  function requireUser(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Please log in' });
    next();
  }

  // Every API request knows who is calling. Writes must be JSON: browsers
  // can't send that cross-site without a CORS preflight, which (together with
  // the SameSite cookie) keeps other sites from acting as a logged-in user.
  app.use('/api', loadSession, (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Expected a JSON request' });
    }
    next();
  });

  const router = asyncRouter();
  router.use(express.json({ limit: '10kb' }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const otpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });

  router.post('/send-otp', otpLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });

    const now = Date.now();
    const existing = await otps.findOne({ email });
    if (existing && now - existing.sentAt.getTime() < OTP_RESEND_MS) {
      return res.status(429).json({ error: 'Please wait a minute before requesting another code' });
    }
    const inWindow = existing && now - existing.windowStart.getTime() < 60 * 60 * 1000;
    if (inWindow && existing.sendCount >= OTP_MAX_SENDS_PER_HOUR) {
      return res.status(429).json({ error: 'Too many codes requested — try again in an hour' });
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      await sendOtpEmail(email, code, OTP_TTL_MS / 1000);
    } catch (err) {
      console.error('OTP email failed:', err);
      return res.status(502).json({ error: "We couldn't send the email — try again shortly" });
    }
    // Every code stays valid until its own expiry, even after a resend —
    // people often open the older email first.
    const live = (existing?.codes || []).filter((c) => c.expiresAt.getTime() > now);
    await otps.updateOne(
      { email },
      {
        $unset: { codeHash: '', expiresAt: '' },
        $set: {
          codes: [...live, { hash: hashOtp(email, code), expiresAt: new Date(now + OTP_TTL_MS) }].slice(-OTP_MAX_SENDS_PER_HOUR),
          purgeAt: new Date(now + 60 * 60 * 1000),
          attempts: 0,
          sentAt: new Date(now),
          windowStart: inWindow ? existing.windowStart : new Date(now),
          sendCount: inWindow ? existing.sendCount + 1 : 1,
        },
      },
      { upsert: true }
    );
    res.json({ ok: true, expiresIn: OTP_TTL_MS / 1000, resendIn: OTP_RESEND_MS / 1000 });
  });

  router.post('/verify-otp', otpLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    const otp = await otps.findOne({ email });
    const codes = otp?.codes || [];
    if (!codes.length) return res.status(400).json({ error: 'Request a new code for this email' });
    if (otp.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ error: 'Too many wrong attempts — request a new code' });

    const given = Buffer.from(hashOtp(email, code));
    const match = /^\d{6}$/.test(code) && codes.find((c) => crypto.timingSafeEqual(given, Buffer.from(c.hash)));
    if (!match) {
      await otps.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
      return res.status(400).json({ error: 'Incorrect code — check and try again' });
    }
    if (match.expiresAt < new Date()) return res.status(400).json({ error: 'This code has expired — tap Resend for a new one' });
    await otps.updateOne({ _id: otp._id }, { $set: { codes: [] } }); // one successful login uses up every code

    const now = new Date();
    const user = await users.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, createdAt: now }, $set: { lastLoginAt: now } },
      { upsert: true, returnDocument: 'after' }
    );

    const token = crypto.randomBytes(32).toString('base64url');
    await sessions.insertOne({
      tokenHash: sha256(token),
      userId: user._id,
      createdAt: now,
      refreshedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    });
    res.cookie(COOKIE_NAME, token, cookieOpts);
    res.json({ user: selfProfile(user) });
  });

  router.post('/logout', async (req, res) => {
    if (req.session) await sessions.deleteOne({ _id: req.session._id });
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ user: req.user ? selfProfile(req.user) : null });
  });

  app.use('/api/auth', router);
  return { requireUser, resolveToken, cookieName: COOKIE_NAME };
}

module.exports = { setupAuth, readCookieHeader };
