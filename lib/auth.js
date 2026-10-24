const crypto = require('crypto');
const express = require('express');
const { asyncRouter } = require('./http');
const { rateLimit } = require('express-rate-limit');
const { sendOtpEmail } = require('./mailer');
const { selfProfile } = require('./profile');

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MS = 60 * 1000;
const OTP_MAX_SENDS_PER_HOUR = 5;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
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

async function setupAuth(app, db, { isProd, onSessionRevoked = () => {} }) {
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

  const cookieOpts = { httpOnly: true, secure: isProd, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS };

  // Resolves a raw session token to { session, user }, or null. Shared by the
  // HTTP middleware below and the chat socket handshake.
  async function resolveToken(token) {
    if (!token) return null;
    const session = await sessions.findOne({ tokenHash: sha256(token) });
    if (!session) return null;
    const now = new Date();
    const createdAt = session.createdAt ? new Date(session.createdAt) : null;
    const hardExpiry = createdAt && Number.isFinite(createdAt.getTime())
      ? new Date(createdAt.getTime() + SESSION_TTL_MS)
      : new Date(session.expiresAt);
    const expiresAt = new Date(Math.min(new Date(session.expiresAt).getTime(), hardExpiry.getTime()));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
      await sessions.deleteOne({ _id: session._id });
      return null;
    }
    // Clamp sessions issued under the previous longer lifetime to 24 hours.
    if (new Date(session.expiresAt).getTime() > expiresAt.getTime()) {
      await sessions.updateOne({ _id: session._id }, { $set: { expiresAt } });
    }
    session.expiresAt = expiresAt;
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

    let now = Date.now();
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
    now = Date.now(); // Give users the full lifetime after the mail server accepts the email.
    // people often open the older email first.
    // Merge against the document at write time. An SMTP send can overlap a
    // verification; a pre-send snapshot must never resurrect consumed codes.
    await otps.updateOne(
      { email },
      [{ $unset: ['codeHash', 'expiresAt'] }, {
        $set: {
          codes: { $slice: [{ $concatArrays: [
            { $filter: { input: { $ifNull: ['$codes', []] }, as: 'code', cond: { $gt: ['$$code.expiresAt', new Date(now)] } } },
            [{ hash: hashOtp(email, code), expiresAt: new Date(now + OTP_TTL_MS) }],
          ] }, -OTP_MAX_SENDS_PER_HOUR] },
          purgeAt: new Date(now + 60 * 60 * 1000),
          attempts: 0,
          sentAt: new Date(now),
          windowStart: inWindow ? existing.windowStart : new Date(now),
          sendCount: inWindow ? existing.sendCount + 1 : 1,
        },
      }],
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
      const attempt = await otps.updateOne(
        { _id: otp._id, attempts: { $lt: OTP_MAX_ATTEMPTS }, 'codes.0': { $exists: true } },
        { $inc: { attempts: 1 } }
      );
      if (!attempt.modifiedCount) return res.status(429).json({ error: 'Too many wrong attempts — request a new code' });
      return res.status(400).json({ error: 'Incorrect code — check and try again' });
    }
    const consumed = await otps.findOneAndUpdate(
      { _id: otp._id, attempts: { $lt: OTP_MAX_ATTEMPTS }, codes: { $elemMatch: { hash: match.hash, expiresAt: { $gt: new Date() } } } },
      { $set: { codes: [] } }, // exactly one successful login consumes every code
      { returnDocument: 'after' }
    );
    if (!consumed) return res.status(400).json({ error: 'This code has expired or was already used — request a new code' });

    const now = new Date();
    const user = await users.findOneAndUpdate(
      { email },
      { $setOnInsert: { email, createdAt: now, accountType: 'customer' }, $set: { lastLoginAt: now } },
      { upsert: true, returnDocument: 'after' }
    );

    const token = crypto.randomBytes(32).toString('base64url');
    await sessions.insertOne({
      tokenHash: sha256(token),
      userId: user._id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    });
    res.cookie(COOKIE_NAME, token, cookieOpts);
    res.json({ user: selfProfile(user) });
  });

  router.post('/logout', async (req, res) => {
    if (req.session) {
      await sessions.deleteOne({ _id: req.session._id });
      onSessionRevoked(String(req.session._id));
    }
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
