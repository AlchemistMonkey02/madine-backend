const fs = require('fs');
const http = require('http');
const path = require('path');
if (fs.existsSync(path.join(__dirname, '.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '.env') });
} else if (fs.existsSync(path.join(__dirname, '..', '.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
} else {
  require('dotenv').config();
}
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { MongoClient } = require('mongodb');
const { transformCafeDoc, encodeUrlPath } = require('./lib/transformCafe');
const { setupAuth } = require('./lib/auth');
const { setupSocial } = require('./lib/social');
const { createRealtime, setupChat } = require('./lib/chat');
const { setupCommunity } = require('./lib/community');
const mailer = require('./lib/mailer');

const {
  MONGODB_URI,
  MONGODB_DB = 'madine',
  MONGODB_COLLECTION = 'madine_core',
  DATASET_ROOT,
  PORT = 4000,
  NODE_ENV = 'development',
  FRONTEND_URL,
  CLIENT_URL,
  CORS_ORIGIN,
} = process.env;

const isProd = NODE_ENV === 'production';

// Only this folder is ever exposed to browsers — backend code, research data
// and .env live outside it and can't be fetched.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : path.join(__dirname, '..', 'public');
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
  let client = null;
  let db = null;

  if (MONGODB_URI) {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log('Connected to MongoDB:', MONGODB_DB + '.' + MONGODB_COLLECTION);
    db = client.db(MONGODB_DB);
  } else {
    console.log('No MONGODB_URI provided — running in standalone local memory mode.');
    const { createMemoryDb } = require('./lib/memoryDb');
    db = createMemoryDb();
    try {
      const { build250Cafes } = require('../tools/seed_cafes');
      const cafes = build250Cafes();
      const col = db.collection(MONGODB_COLLECTION);
      for (const cafe of cafes) {
        await col.insertOne(cafe);
      }
      console.log(`Loaded ${cafes.length} cafes into in-memory store.`);
    } catch (e) {
      console.warn('Could not auto-seed in-memory cafes:', e.message);
    }
  }

  const collection = db.collection(MONGODB_COLLECTION);

  let cafeCache = null;
  let cafeCacheAt = 0;
  async function getCafes() {
    if (!cafeCache || Date.now() - cafeCacheAt > CAFE_CACHE_MS) {
      const docs = await collection.find({}).toArray();
      cafeCache = docs.map((doc) => transformCafeDoc(doc, { menuImages: menuImagesFor(doc) }));
      cafeCacheAt = Date.now();
    }
    return cafeCache;
  }
  let cafeIdSet = null;
  let cafeIdSetFor = null;
  async function getCafeIds() {
    const cafes = await getCafes();
    if (cafeIdSetFor !== cafes) { cafeIdSet = new Set(cafes.map((c) => c.id)); cafeIdSetFor = cafes; }
    return cafeIdSet;
  }

  const configuredOrigins = [
    FRONTEND_URL,
    CLIENT_URL,
    ...(CORS_ORIGIN ? CORS_ORIGIN.split(',').map((s) => s.trim()) : []),
  ].filter(Boolean);

  const corsOrigins = configuredOrigins.length ? configuredOrigins : ['*'];

  const app = express();
  const server = http.createServer(app);
  const { io, notify } = createRealtime(server, { corsOrigins });

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind the host's HTTPS proxy (Render, Nginx, etc.)
  app.use(compression());

  // CORS middleware for separated frontend and API access
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (corsOrigins.includes('*') || corsOrigins.includes(origin)) return callback(null, true);
        // Allow all local development origins (localhost / 127.0.0.1 on any port)
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        if (configuredOrigins.some((allowed) => allowed === origin || (allowed.endsWith('*') && origin.startsWith(allowed.slice(0, -1))))) {
          return callback(null, true);
        }
        if (!isProd) return callback(null, true);
        callback(null, true);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'X-Requested-With'],
      exposedHeaders: ['Set-Cookie'],
    })
  );

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // --- API routes ---
  const { requireUser, resolveToken, cookieName } = await setupAuth(app, db, { isProd });
  if (!mailer.isConfigured()) console.warn('SMTP not configured — emails will be printed here instead of sent.');
  const { requireProfile, connectedIds, pairKey, toId } = await setupSocial(app, db, { requireUser, getCafeIds, notify });
  await setupChat(app, db, { io, notify, resolveToken, cookieName, requireUser, connectedIds, pairKey, toId });
  await setupCommunity(app, db, { requireUser, requireProfile, getCafes, toId });

  app.get('/api/cafes', async (req, res) => {
    try {
      const cafes = await getCafes();
      res.set('Cache-Control', 'public, max-age=300');
      res.json({ count: cafes.length, cafes });
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

  app.get('/api/health', (req, res) => res.json({ ok: true, email: mailer.isConfigured() ? 'smtp' : 'console-only' }));

  // --- Café photos + menu cards ---
  // Static route with cross-origin headers so standalone frontends can render them
  const imageDirs = [CAFE_IMAGES_DIR, DATASET_ROOT].filter((d) => d && fs.existsSync(d));
  imageDirs.forEach((dir) =>
    app.use(
      '/cafe-images',
      (req, res, next) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
      },
      express.static(dir, { maxAge: '30d', immutable: true })
    )
  );
  if (!imageDirs.length) {
    console.warn('No café images found — run `npm run prepare-images` before deploying.');
  }

  // --- Frontend (Optional / Fallback) ---
  if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR, { maxAge: isProd ? '1h' : 0 }));
  }
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request' });
    console.error(`${req.method} ${req.originalUrl} failed:`, err);
    res.status(500).json({ error: 'Something went wrong — try again' });
  });
  if (fs.existsSync(PUBLIC_DIR)) {
    app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, 'index.html')));
  }

  server.listen(PORT, () => {
    console.log(`\nVYBE Platform running at http://localhost:${PORT} (${NODE_ENV})`);
    console.log(`API:  http://localhost:${PORT}/api/cafes`);
  });

  // Hosts send SIGTERM on every redeploy — finish in-flight requests first.
  const shutdown = () => {
    // Open chat sockets would otherwise keep the server alive, so close them
    // and never wait more than a few seconds (dev restarts, redeploys).
    setTimeout(() => process.exit(0), 3000).unref();
    io.close();
    server.close(() => {
      if (client) {
        client.close().finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
