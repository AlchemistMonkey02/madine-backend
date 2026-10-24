require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { MongoClient } = require('mongodb');
const { transformCafeDoc, encodeUrlPath } = require('./lib/transformCafe');
const { setupAuth } = require('./lib/auth');
const { setupSocial } = require('./lib/social');
const { createRealtime, setupChat } = require('./lib/chat');
const { setupCommunity } = require('./lib/community');
const { setupPlatform, approvedCafeView } = require('./lib/platform');
const { createCatalogResponseCache } = require('./lib/catalogResponse');
const mailer = require('./lib/mailer');

const {
  MONGODB_URI,
  MONGODB_DB = 'madine',
  MONGODB_COLLECTION = 'madine_core',
  DATASET_ROOT,
  PORT = process.env.NODE_ENV === 'production' ? 3000 : 4000,
  NODE_ENV = 'development',
} = process.env;

const isProd = NODE_ENV === 'production';
const listenPort = Number(PORT);

function validateProductionConfig() {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 11) || nodeMajor >= 25) {
    throw new Error('MADINE requires Node.js 22.11 or newer in the 22.x or 24.x LTS line');
  }
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (!isProd) return;
  let publicUrl;
  try { publicUrl = new URL(process.env.APP_URL || ''); } catch {}
  if (!publicUrl || publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password ||
      publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
    throw new Error('Production requires APP_URL to be a valid HTTPS origin');
  }
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  if (!process.env.SMTP_HOST || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535 ||
      !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.MAIL_FROM) {
    throw new Error('Production requires SMTP_HOST, a valid SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM');
  }
}

// Only this folder is ever exposed to browsers — backend code, research data
// and .env live outside it and can't be fetched.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
// The static preload helper is the only inline script. Hash it so CSP can
// allow that exact code without enabling arbitrary inline scripts/handlers.
const inlineScriptHashes = [...fs.readFileSync(INDEX_HTML, 'utf8').matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .filter((match) => !/\bsrc\s*=/.test(match[0].slice(0, match[0].indexOf('>') + 1)))
  .map((match) => `'sha256-${crypto.createHash('sha256').update(match[1].replace(/\r\n?/g, '\n')).digest('base64')}'`);
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${inlineScriptHashes.join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
const CAFE_IMAGES_DIR = path.join(PUBLIC_DIR, 'cafe-images');
const MENU_IMAGES_DIR = path.join(CAFE_IMAGES_DIR, 'menus');
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

// The café list only changes when the ingest script runs, so serve it from
// memory and refresh every few minutes instead of hitting Mongo per visitor.
const CAFE_CACHE_MS = 5 * 60 * 1000;

const byNaturalName = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Menu card photos for one café. Prefers the web-optimised copies written by
// `npm run prepare-images` (public/cafe-images/menus/<id>/NN.webp + NN.thumb.webp);
// in local dev, falls back to the raw files under the dataset's menu_local_path.
function menuImagesFor(doc) {
  const prepared = path.join(MENU_IMAGES_DIR, doc.id || '');
  if (doc.id && fs.existsSync(prepared)) {
    return fs.readdirSync(prepared)
      .filter((f) => f.endsWith('.webp') && !f.endsWith('.thumb.webp'))
      .sort(byNaturalName)
      .map((f) => {
        const base = `/cafe-images/menus/${encodeURIComponent(doc.id)}/`;
        return { src: base + f, thumb: base + f.replace(/\.webp$/, '.thumb.webp') };
      });
  }
  if (!DATASET_ROOT || !doc.menu_local_path) return [];
  const rel = doc.menu_local_path.replace(/\\/g, '/').split('/').filter(Boolean);
  let dir = path.join(DATASET_ROOT, ...rel);
  if (!fs.existsSync(dir)) {
    // Windows strips trailing dots from folder names ("..._Co." -> "..._Co").
    rel[rel.length - 1] = rel[rel.length - 1].replace(/\.+$/, '');
    dir = path.join(DATASET_ROOT, ...rel);
    if (!fs.existsSync(dir)) return [];
  }
  return fs.readdirSync(dir)
    .filter((f) => IMAGE_EXT.test(f))
    .sort(byNaturalName)
    .map((f) => {
      const url = encodeUrlPath(['/cafe-images', ...rel, f].join('/'));
      return { src: url, thumb: url };
    });
}

async function main() {
  validateProductionConfig();
  if (!MONGODB_URI) throw new Error('MONGODB_URI is not set (see .env.example)');

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  if (isProd) {
    const topology = await client.db('admin').command({ hello: 1 });
    if (!(topology.setName || topology.msg === 'isdbgrid') || topology.logicalSessionTimeoutMinutes == null) {
      await client.close();
      throw new Error('Production MongoDB must be a replica set or sharded cluster with transaction support');
    }
  }
  console.log('Connected to MongoDB:', MONGODB_DB + '.' + MONGODB_COLLECTION);
  const db = client.db(MONGODB_DB);
  const collection = db.collection(MONGODB_COLLECTION);

  let cafeCache = null;
  let cafeCacheAt = 0;
  let cafeCacheLoading = null;
  async function getCafes() {
    if (cafeCache && Date.now() - cafeCacheAt <= CAFE_CACHE_MS) return cafeCache;
    if (!cafeCacheLoading) cafeCacheLoading = (async () => {
      const [docs, managed] = await Promise.all([
        collection.find({}).toArray(),
        db.collection('cafe_submissions').find({ publishedDetails: { $exists: true } }).toArray(),
      ]);
      const catalog = new Map(docs.map((doc) => [doc.id, transformCafeDoc(doc, { menuImages: menuImagesFor(doc) })]));
      for (const doc of managed) {
        const cafe = approvedCafeView(doc, catalog.get(doc.existingCafeId));
        catalog.set(cafe.id, cafe);
      }
      cafeCache = [...catalog.values()];
      cafeCacheAt = Date.now();
      return cafeCache;
    })().finally(() => { cafeCacheLoading = null; });
    return cafeCacheLoading;
  }
  let cafeIdSet = null;
  let cafeIdSetFor = null;
  async function getCafeIds() {
    const cafes = await getCafes();
    if (cafeIdSetFor !== cafes) { cafeIdSet = new Set(cafes.map((c) => c.id)); cafeIdSetFor = cafes; }
    return cafeIdSet;
  }

  const app = express();
  const server = http.createServer(app);
  const { io, notify } = createRealtime(server);
  app.disable('x-powered-by');
  app.set('trust proxy', isProd ? 1 : false); // production hosts must use one trusted HTTPS reverse proxy
  app.use(compression());
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (isProd && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  // --- API routes ---
  const { requireUser, resolveToken, cookieName } = await setupAuth(app, db, {
    isProd,
    onSessionRevoked: (id) => {
      io.to(`session:${id}`).emit('session:invalid');
      io.in(`session:${id}`).disconnectSockets(true);
    },
  });
  if (!mailer.isConfigured()) console.warn('SMTP not configured — emails will be printed here instead of sent.');
  let platformNotify = async () => {};
  const pushNotification = (...args) => platformNotify(...args);
  const { requireProfile, connectedIds, pairKey, toId } = await setupSocial(app, db, { requireUser, getCafeIds, notify, pushNotification });
  const platform = await setupPlatform(app, db, { requireUser, requireProfile, getCafes, toId, notify, invalidateCafeCache: () => { cafeCache = null; cafeCacheAt = 0; } });
  platformNotify = platform.pushNotification;
  await setupChat(app, db, { io, notify, resolveToken, cookieName, requireUser, connectedIds, pairKey, toId });
  await setupCommunity(app, db, { client, requireUser, requireProfile, getCafes, toId, pushNotification });

  const catalogResponseFor = createCatalogResponseCache();
  app.get('/api/cafes', async (req, res) => {
    try {
      const cafes = await getCafes();
      const payload = await catalogResponseFor(cafes);
      res.set('Cache-Control', 'public, max-age=300');
      res.set('ETag', payload.etag);
      res.vary('Accept-Encoding');
      if (req.fresh) return res.status(304).end();
      res.type('application/json');
      if (req.acceptsEncodings('gzip', 'identity') === 'gzip') {
        res.set('Content-Encoding', 'gzip');
        return res.send(payload.gzip);
      }
      res.send(payload.json);
    } catch (err) {
      console.error('GET /api/cafes failed:', err);
      res.status(500).json({ error: 'Failed to load cafes' });
    }
  });

  app.get('/api/cafes/:id', async (req, res) => {
    try {
      const cafe = (await getCafes()).find((c) => c.id === req.params.id);
      if (!cafe) return res.status(404).json({ error: 'Cafe not found' });
      res.json(cafe);
    } catch (err) {
      console.error('GET /api/cafes/:id failed:', err);
      res.status(500).json({ error: 'Failed to load cafe' });
    }
  });

  app.get('/api/health', async (req, res) => {
    try {
      await client.db(MONGODB_DB).command({ ping: 1 });
      res.json({ ok: true, email: mailer.isConfigured() ? 'smtp' : 'console-only' });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // --- Café photos + menu cards ---
  // Production: web-sized copies in public/cafe-images (npm run prepare-images).
  // Local dev: anything not prepared yet falls through to the raw dataset folder.
  const imageDirs = [CAFE_IMAGES_DIR, DATASET_ROOT].filter((d) => d && fs.existsSync(d));
  imageDirs.forEach((dir) => app.use('/cafe-images', express.static(dir, { maxAge: '30d', immutable: true })));
  if (!imageDirs.length) {
    console.warn('No café images found — run `npm run prepare-images` before deploying.');
  }

  // --- Frontend ---
  app.use(express.static(PUBLIC_DIR, {
    maxAge: isProd ? '1h' : 0,
    setHeaders(res, filePath) {
      if (path.extname(filePath) === '.html') res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Something went wrong — try again' });
  });
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));

  server.listen(listenPort, '0.0.0.0', () => {
    console.log(`\nMADINE listening on port ${listenPort} (${NODE_ENV})`);
    console.log('API: /api/cafes');
  });

  // Hosts send SIGTERM on every redeploy — finish in-flight requests first.
  const shutdown = () => {
    // Open chat sockets would otherwise keep the server alive, so close them
    // and never wait more than a few seconds (dev restarts, redeploys).
    setTimeout(() => process.exit(0), 3000).unref();
    io.close();
    server.closeAllConnections();
    server.close(() => client.close().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
