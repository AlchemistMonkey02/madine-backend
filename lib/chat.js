const express = require('express');
const { asyncRouter } = require('./http');
const { Server } = require('socket.io');
const { readCookieHeader } = require('./auth');

const MAX_MESSAGE_LEN = 2000;
const HISTORY_LIMIT = 200;
const SEND_WINDOW_MS = 10 * 1000;
const SEND_LIMIT = 20; // messages per window per socket

const room = (userId) => `u:${userId}`;
const wireMessage = (m) => ({ id: String(m._id), from: String(m.from), to: String(m.to), text: m.text, timestamp: m.createdAt.getTime(), read: !!m.readAt });

// Creates the socket server first so REST routes can push live updates
// through notify() before the chat routes themselves are mounted.
function createRealtime(httpServer, { corsOrigins = [] } = {}) {
  const io = new Server(httpServer, {
    serveClient: true,
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (corsOrigins.includes('*') || corsOrigins.includes(origin)) return callback(null, true);
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        return callback(null, true);
      },
      credentials: true,
      methods: ['GET', 'POST'],
    },
    allowRequest: (req, cb) => {
      cb(null, true);
    },
  });
  const notify = (userId, event, payload) => io.to(room(userId)).emit(event, payload);
  return { io, notify };
}

async function setupChat(app, db, { io, notify, resolveToken, cookieName, requireUser, connectedIds, pairKey, toId }) {
  const messages = db.collection('messages');
  const connections = db.collection('connections');
  await messages.createIndex({ pair: 1, createdAt: -1 });
  await messages.createIndex({ to: 1, readAt: 1 });

  const isConnected = async (a, b) => !!(await connections.findOne({ _id: pairKey(a, b), status: 'accepted' }, { projection: { _id: 1 } }));

  /* ---------- REST: history + conversation list ---------- */
  const router = asyncRouter();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/conversations', requireUser, async (req, res) => {
    const me = req.user._id;
    const rows = await messages.aggregate([
      { $match: { $or: [{ from: me }, { to: me }] } },
      { $sort: { createdAt: -1 } },
      { $group: { _id: '$pair', last: { $first: '$$ROOT' }, unread: { $sum: { $cond: [{ $and: [{ $eq: ['$to', me] }, { $not: ['$readAt'] }] }, 1, 0] } } } },
    ]).toArray();
    res.json({
      conversations: rows.map((r) => {
        const last = wireMessage(r.last);
        return { userId: last.from === String(me) ? last.to : last.from, last, unread: r.unread };
      }),
    });
  });

  router.get('/messages/:userId', requireUser, async (req, res) => {
    const other = toId(req.params.userId);
    if (!other) return res.status(400).json({ error: 'Invalid person' });
    const list = await messages.find({ pair: pairKey(req.user._id, other) }).sort({ createdAt: -1 }).limit(HISTORY_LIMIT).toArray();
    res.json({ messages: list.reverse().map(wireMessage) });
  });

  app.use('/api', router);

  /* ---------- sockets ---------- */
  const online = new Map(); // userId -> open socket count

  io.use(async (socket, next) => {
    try {
      const found = await resolveToken(readCookieHeader(socket.handshake.headers.cookie, cookieName));
      if (!found) return next(new Error('unauthorized'));
      socket.data.userId = found.user._id;
      next();
    } catch (err) {
      next(err);
    }
  });

  io.on('connection', async (socket) => {
    const me = socket.data.userId;
    const meStr = String(me);
    socket.join(room(meStr));

    const count = (online.get(meStr) || 0) + 1;
    online.set(meStr, count);
    if (count === 1) (await connectedIds(me)).forEach((id) => notify(id, 'presence', { userId: meStr, online: true }));

    let windowStart = Date.now();
    let sentInWindow = 0;

    socket.on('message:send', async (payload, ack = () => {}) => {
      try {
        const to = toId(String(payload?.to || ''));
        const text = String(payload?.text || '').trim().slice(0, MAX_MESSAGE_LEN);
        if (!to || !text) return ack({ error: 'Empty message' });
        if (Date.now() - windowStart > SEND_WINDOW_MS) { windowStart = Date.now(); sentInWindow = 0; }
        if (++sentInWindow > SEND_LIMIT) return ack({ error: "You're sending messages too fast" });
        if (!(await isConnected(me, to))) return ack({ error: 'You can only message your connections' });

        const doc = { pair: pairKey(me, to), from: me, to, text, createdAt: new Date(), readAt: null };
        const { insertedId } = await messages.insertOne(doc);
        const msg = wireMessage({ ...doc, _id: insertedId });
        notify(String(to), 'message', msg);
        socket.to(room(meStr)).emit('message', msg); // my other open tabs
        ack({ message: msg });
      } catch (err) {
        console.error('message:send failed:', err);
        ack({ error: 'Message failed to send' });
      }
    });

    socket.on('typing', async (payload) => {
      const to = toId(String(payload?.to || ''));
      if (to && (await isConnected(me, to))) notify(String(to), 'typing', { from: meStr, typing: !!payload.typing });
    });

    socket.on('messages:read', async (payload) => {
      const other = toId(String(payload?.with || ''));
      if (!other) return;
      await messages.updateMany({ pair: pairKey(me, other), to: me, readAt: null }, { $set: { readAt: new Date() } });
    });

    socket.on('presence:query', async (ids, ack = () => {}) => {
      if (!Array.isArray(ids)) return ack({});
      const allowed = new Set((await connectedIds(me)).map(String));
      ack(Object.fromEntries(ids.slice(0, 500).map(String).filter((id) => allowed.has(id)).map((id) => [id, online.has(id)])));
    });

    socket.on('disconnect', async () => {
      const left = (online.get(meStr) || 1) - 1;
      if (left > 0) return online.set(meStr, left);
      online.delete(meStr);
      (await connectedIds(me)).forEach((id) => notify(id, 'presence', { userId: meStr, online: false }));
    });
  });
}

module.exports = { createRealtime, setupChat };
