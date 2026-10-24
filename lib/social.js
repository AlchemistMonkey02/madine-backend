const express = require('express');
const { asyncRouter } = require('./http');
const { ObjectId } = require('mongodb');
const { PREFERENCE_OPTIONS, publicProfile, selfProfile } = require('./profile');
const { sendConnectionRequestEmail, sendConnectionAcceptedEmail } = require('./mailer');
const { decodeAvatar } = require('./avatar');

const MAX_CHECKIN_MS = 12 * 60 * 60 * 1000;
const MAX_CHECKIN_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_CHECKINS = 20;

const pairKey = (a, b) => [String(a), String(b)].sort().join(':');
const toId = (s) => (ObjectId.isValid(s) && String(new ObjectId(s)) === s ? new ObjectId(s) : null);
const cleanText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanList = (v, maxItems, maxLen) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => cleanText(x, maxLen)).filter(Boolean))].slice(0, maxItems);

// The other user's id → 'sent' | 'incoming' | 'connected', from my point of view.
function connectionStateFor(doc, me) {
  if (!doc) return 'none';
  if (doc.status === 'accepted') return 'connected';
  return String(doc.from) === String(me) ? 'sent' : 'incoming';
}

async function setupSocial(app, db, { requireUser, getCafeIds, notify, pushNotification = async () => {} }) {
  const users = db.collection('users');
  const avatars = db.collection('avatars');
  const connections = db.collection('connections');
  const checkins = db.collection('checkins');

  await Promise.all([
    users.createIndex({ lastLoginAt: -1 }),
    connections.createIndex({ from: 1 }),
    connections.createIndex({ to: 1 }),
    checkins.createIndex({ cafeId: 1, startsAt: 1, endsAt: 1, openToChat: 1 }),
    checkins.createIndex({ userId: 1 }),
    checkins.createIndex({ endsAt: 1 }, { expireAfterSeconds: 0 }), // past check-ins delete themselves
  ]);

  const requireProfile = (req, res, next) =>
    req.user?.name ? next() : res.status(403).json({ error: 'Set up your profile first' });

  async function connectedIds(me) {
    const docs = await connections.find({ status: 'accepted', $or: [{ from: me }, { to: me }] }).toArray();
    return docs.map((d) => (String(d.from) === String(me) ? d.to : d.from));
  }

  const router = asyncRouter();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  /* ---------- my profile ---------- */
  router.put('/me/profile', express.json({ limit: '20kb' }), requireUser, async (req, res) => {
    const b = req.body || {};
    const name = cleanText(b.name, 40);
    if (!name) return res.status(400).json({ error: 'Please add your name' });
    const cafeIds = await getCafeIds();
    const update = {
      name,
      role: cleanText(b.role, 40),
      bio: cleanText(b.bio, 280),
      interests: cleanList(b.interests, 10, 24),
      favoriteCafes: cleanList(b.favoriteCafes, 5, 80).filter((id) => cafeIds.has(id)),
      preference: cleanList(b.preference, 5, 20).filter((p) => PREFERENCE_OPTIONS.includes(p)),
      updatedAt: new Date(),
    };
    const user = await users.findOneAndUpdate({ _id: req.user._id }, { $set: update }, { returnDocument: 'after' });
    res.json({ user: selfProfile(user) });
  });

  // Decode and normalize on the server: clients can bypass the browser's resize.
  router.put('/me/avatar', express.json({ limit: '450kb' }), requireUser, async (req, res) => {
    const decoded = await decodeAvatar(req.body?.dataUrl);
    if (decoded.error) return res.status(decoded.status).json({ error: decoded.error });
    const version = Date.now();
    await avatars.updateOne({ _id: req.user._id }, { $set: { data: decoded.data, contentType: decoded.contentType, updatedAt: new Date() } }, { upsert: true });
    const user = await users.findOneAndUpdate({ _id: req.user._id }, { $set: { avatarVersion: version } }, { returnDocument: 'after' });
    res.json({ user: selfProfile(user) });
  });

  router.put('/me/saved', express.json({ limit: '2kb' }), requireUser, async (req, res) => {
    const cafeId = cleanText(req.body?.cafeId, 80);
    if (!(await getCafeIds()).has(cafeId)) return res.status(404).json({ error: 'Cafe not found' });
    const op = req.body?.saved ? { $addToSet: { saved: cafeId } } : { $pull: { saved: cafeId } };
    const user = await users.findOneAndUpdate({ _id: req.user._id }, op, { returnDocument: 'after' });
    res.json({ saved: user.saved || [] });
  });

  /* ---------- people ---------- */
  router.get('/people', async (req, res) => {
    const filter = { name: { $nin: [null, ''] } };
    if (req.user) filter._id = { $ne: req.user._id };
    const list = await users.find(filter).sort({ lastLoginAt: -1 }).limit(500).toArray();
    res.json({ people: list.map(publicProfile) });
  });

  router.get('/users/:id/avatar', async (req, res) => {
    const id = toId(req.params.id);
    const doc = id && (await avatars.findOne({ _id: id }));
    if (!doc) return res.status(404).end();
    // The URL carries ?v=<version>, so a new photo always gets a new URL.
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(doc.contentType).send(doc.data.buffer ? Buffer.from(doc.data.buffer) : doc.data);
  });

  /* ---------- connections ---------- */
  router.get('/connections', requireUser, async (req, res) => {
    const me = req.user._id;
    const docs = await connections.find({ $or: [{ from: me }, { to: me }] }).toArray();
    const map = {};
    docs.forEach((d) => { map[String(String(d.from) === String(me) ? d.to : d.from)] = connectionStateFor(d, me); });
    res.json({ connections: map });
  });

  router.post('/connections/:id', express.json({ limit: '1kb' }), requireUser, requireProfile, async (req, res) => {
    const me = req.user._id;
    const other = toId(req.params.id);
    const action = String(req.body?.action || '');
    if (!other || String(other) === String(me)) return res.status(400).json({ error: 'Invalid person' });
    const otherUser = await users.findOne({ _id: other, name: { $nin: [null, ''] } });
    if (!otherUser) return res.status(404).json({ error: 'Person not found' });
    const _id = pairKey(me, other);
    let doc = await connections.findOne({ _id });
    const state = connectionStateFor(doc, me);
    const now = new Date();

    if (action === 'connect' && state === 'none') {
      try {
        await connections.insertOne({ _id, from: me, to: other, status: 'pending', createdAt: now });
        sendConnectionRequestEmail(otherUser.email, publicProfile(req.user));
        await pushNotification(other, { title: (req.user.name || 'A MADINE member') + ' wants to connect', href: '#connections', type: 'connection' });
      } catch (err) {
        if (err.code !== 11000) throw err; // they sent one at the same moment — fall through to the current state
      }
    } else if ((action === 'accept' || action === 'connect') && state === 'incoming') {
      await connections.updateOne({ _id }, { $set: { status: 'accepted', acceptedAt: now } });
      sendConnectionAcceptedEmail(otherUser.email, publicProfile(req.user));
      await pushNotification(other, { title: (req.user.name || 'A MADINE member') + ' accepted your request', href: '#messages', type: 'connection' });
    } else if ((action === 'cancel' && state === 'sent') || (action === 'reject' && state === 'incoming') || (action === 'remove' && state === 'connected')) {
      await connections.deleteOne({ _id });
    } else {
      return res.status(409).json({ error: 'That request is no longer available', state });
    }

    doc = await connections.findOne({ _id });
    notify(other, 'connections:changed', {});
    res.json({ state: connectionStateFor(doc, me) });
  });

  /* ---------- check-ins (visible to me and my connections only) ---------- */
  router.get('/cafes/:id/checkins', async (req, res) => {
    if (!req.user) return res.json({ checkins: [] });
    const me = req.user._id;
    const visible = [me, ...(await connectedIds(me))];
    const list = await checkins
      .find({ cafeId: req.params.id, endsAt: { $gt: new Date() }, userId: { $in: visible } })
      .sort({ startsAt: 1 })
      .limit(100)
      .toArray();
    res.json({
      checkins: list.map((c) => {
        const mine = String(c.userId) === String(me);
        return { id: String(c._id), userId: String(c.userId), mine, startsAt: c.startsAt, endsAt: c.endsAt, openToChat: mine && c.openToChat === true };
      }),
    });
  });

  // Match only users who explicitly opted in and whose check-in is active now.
  // Matching reveals no email data and requires an active opted-in check-in.
  router.get('/cafes/:id/diners', requireUser, async (req, res) => {
    const cafeId = cleanText(req.params.id, 80);
    if (!(await getCafeIds()).has(cafeId)) return res.status(404).json({ error: 'Cafe not found' });
    const now = new Date();
    const own = await checkins.findOne({ cafeId, userId: req.user._id, startsAt: { $lte: now }, endsAt: { $gt: now }, openToChat: true });
    if (!own) return res.json({ optedIn: false, diners: [] });
    const matches = await checkins.find({ cafeId, userId: { $ne: req.user._id }, startsAt: { $lte: now }, endsAt: { $gt: now }, openToChat: true }).project({ userId: 1 }).limit(20).toArray();
    const ids = [...new Map(matches.map((match) => [String(match.userId), match.userId])).values()];
    const people = ids.length ? await users.find({ _id: { $in: ids }, name: { $nin: [null, ''] } }).project({ _id: 1, name: 1 }).toArray() : [];
    res.json({ optedIn: true, diners: people.map((person) => ({ userId: String(person._id), name: person.name })) });
  });

  router.put('/checkins/:id/discovery', express.json({ limit: '1kb' }), requireUser, async (req, res) => {
    const id = toId(req.params.id);
    if (!id || typeof req.body?.openToChat !== 'boolean') return res.status(400).json({ error: 'Choose whether you want to be discoverable' });
    const now = new Date();
    const result = await checkins.updateOne({ _id: id, userId: req.user._id, endsAt: { $gt: now } }, { $set: { openToChat: req.body.openToChat } });
    if (!result.matchedCount) return res.status(404).json({ error: 'Active check-in not found' });
    res.json({ openToChat: req.body.openToChat });
  });

  router.post('/checkins', express.json({ limit: '1kb' }), requireUser, requireProfile, async (req, res) => {
    const cafeId = cleanText(req.body?.cafeId, 80);
    const startsAt = new Date(req.body?.startsAt);
    const endsAt = new Date(req.body?.endsAt);
    const now = Date.now();
    if (!(await getCafeIds()).has(cafeId)) return res.status(404).json({ error: 'Cafe not found' });
    if (isNaN(startsAt) || isNaN(endsAt) || endsAt <= startsAt) return res.status(400).json({ error: 'The end time must be after the start time' });
    if (endsAt.getTime() <= now) return res.status(400).json({ error: 'That time has already passed' });
    if (endsAt - startsAt > MAX_CHECKIN_MS) return res.status(400).json({ error: 'A check-in can be at most 12 hours long' });
    if (startsAt.getTime() > now + MAX_CHECKIN_AHEAD_MS) return res.status(400).json({ error: 'You can plan up to 2 weeks ahead' });
    const active = await checkins.countDocuments({ userId: req.user._id, endsAt: { $gt: new Date() } });
    if (active >= MAX_ACTIVE_CHECKINS) return res.status(429).json({ error: 'You have too many upcoming check-ins' });

    const doc = { userId: req.user._id, cafeId, startsAt, endsAt, openToChat: req.body?.openToChat === true, createdAt: new Date() };
    const { insertedId } = await checkins.insertOne(doc);
    (await connectedIds(req.user._id)).forEach((id) => notify(id, 'checkins:changed', { cafeId }));
    res.json({ checkin: { id: String(insertedId), userId: String(req.user._id), mine: true, startsAt, endsAt } });
  });

  router.delete('/checkins/:id', requireUser, async (req, res) => {
    const id = toId(req.params.id);
    const doc = id && (await checkins.findOneAndDelete({ _id: id, userId: req.user._id }));
    if (!doc) return res.status(404).json({ error: 'Check-in not found' });
    (await connectedIds(req.user._id)).forEach((uid) => notify(uid, 'checkins:changed', { cafeId: doc.cafeId }));
    res.json({ ok: true });
  });

  app.use('/api', router);
  return { requireProfile, connectedIds, pairKey, toId };
}

module.exports = { setupSocial };
