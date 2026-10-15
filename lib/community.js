const express = require('express');
const { asyncRouter } = require('./http');

const MAX_EVENT_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const PAST_EVENT_GRACE_MS = 3 * 60 * 60 * 1000; // keep an event listed while it's likely still on

const cleanText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanParagraph = (v, max) => String(v ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const cleanList = (v, maxItems, maxLen) =>
  [...new Set((Array.isArray(v) ? v : []).map((x) => cleanText(x, maxLen)).filter(Boolean))].slice(0, maxItems);

async function setupCommunity(app, db, { requireUser, requireProfile, getCafes, toId }) {
  const communities = db.collection('communities');
  const members = db.collection('community_members');
  const events = db.collection('events');
  const rsvps = db.collection('event_rsvps');

  await Promise.all([
    communities.createIndex({ nameKey: 1 }, { unique: true }),
    communities.createIndex({ memberCount: -1 }),
    members.createIndex({ userId: 1 }),
    events.createIndex({ startsAt: 1 }),
    rsvps.createIndex({ userId: 1 }),
  ]);

  const shapeCommunity = (c, joinedIds, upcoming) => ({
    id: String(c._id),
    name: c.name,
    description: c.description,
    tags: c.tags,
    memberCount: c.memberCount,
    upcomingEvents: upcoming[String(c._id)] || 0,
    joined: joinedIds.has(String(c._id)),
    isOwner: false,
  });

  const shapeEvent = (e, goingIds) => ({
    id: String(e._id),
    title: e.title,
    description: e.description,
    cafeId: e.cafeId,
    cafeName: e.cafeName,
    startsAt: e.startsAt,
    communityId: e.communityId ? String(e.communityId) : null,
    communityName: e.communityName || null,
    capacity: e.capacity || null,
    goingCount: e.goingCount,
    going: goingIds.has(String(e._id)),
  });

  const router = asyncRouter();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  /* ---------- communities ---------- */
  router.get('/communities', async (req, res) => {
    const list = await communities.find({}).sort({ memberCount: -1, createdAt: -1 }).limit(200).toArray();
    const mine = req.user ? await members.find({ userId: req.user._id }).toArray() : [];
    const joinedIds = new Set(mine.map((m) => String(m.communityId)));
    const ownerIds = new Set(mine.filter((m) => m.role === 'owner').map((m) => String(m.communityId)));
    const upcomingRows = await events.aggregate([
      { $match: { communityId: { $ne: null }, startsAt: { $gt: new Date() } } },
      { $group: { _id: '$communityId', n: { $sum: 1 } } },
    ]).toArray();
    const upcoming = Object.fromEntries(upcomingRows.map((r) => [String(r._id), r.n]));
    res.json({ communities: list.map((c) => ({ ...shapeCommunity(c, joinedIds, upcoming), isOwner: ownerIds.has(String(c._id)) })) });
  });

  router.post('/communities', express.json({ limit: '5kb' }), requireUser, requireProfile, async (req, res) => {
    const name = cleanText(req.body?.name, 60);
    const description = cleanParagraph(req.body?.description, 300);
    const tags = cleanList(req.body?.tags, 4, 24);
    if (name.length < 3) return res.status(400).json({ error: 'Give your community a name (at least 3 characters)' });
    if (!description) return res.status(400).json({ error: 'Add a short description' });

    const now = new Date();
    const doc = { name, nameKey: name.toLowerCase(), description, tags, createdBy: req.user._id, createdAt: now, memberCount: 1 };
    try {
      const { insertedId } = await communities.insertOne(doc);
      await members.insertOne({ _id: `${insertedId}:${req.user._id}`, communityId: insertedId, userId: req.user._id, role: 'owner', joinedAt: now });
      res.json({ community: { ...shapeCommunity({ ...doc, _id: insertedId }, new Set([String(insertedId)]), {}), isOwner: true } });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'A community with that name already exists' });
      throw err;
    }
  });

  router.post('/communities/:id/:action(join|leave)', requireUser, async (req, res) => {
    const id = toId(req.params.id);
    const community = id && (await communities.findOne({ _id: id }));
    if (!community) return res.status(404).json({ error: 'Community not found' });
    const key = `${id}:${req.user._id}`;

    if (req.params.action === 'join') {
      try {
        await members.insertOne({ _id: key, communityId: id, userId: req.user._id, role: 'member', joinedAt: new Date() });
        await communities.updateOne({ _id: id }, { $inc: { memberCount: 1 } });
      } catch (err) {
        if (err.code !== 11000) throw err; // already a member
      }
    } else {
      const membership = await members.findOne({ _id: key });
      if (membership?.role === 'owner') return res.status(400).json({ error: "You created this community, so you can't leave it" });
      if (membership) {
        await members.deleteOne({ _id: key });
        await communities.updateOne({ _id: id }, { $inc: { memberCount: -1 } });
      }
    }
    const fresh = await communities.findOne({ _id: id });
    res.json({ joined: req.params.action === 'join', memberCount: fresh.memberCount });
  });

  /* ---------- events ---------- */
  router.get('/events', async (req, res) => {
    const list = await events.find({ startsAt: { $gt: new Date(Date.now() - PAST_EVENT_GRACE_MS) } }).sort({ startsAt: 1 }).limit(200).toArray();
    const goingIds = new Set(req.user ? (await rsvps.find({ userId: req.user._id }).toArray()).map((r) => String(r.eventId)) : []);
    res.json({ events: list.map((e) => shapeEvent(e, goingIds)) });
  });

  router.post('/events', express.json({ limit: '5kb' }), requireUser, requireProfile, async (req, res) => {
    const b = req.body || {};
    const title = cleanText(b.title, 80);
    const description = cleanParagraph(b.description, 500);
    const startsAt = new Date(b.startsAt);
    const capacity = b.capacity ? Math.floor(Number(b.capacity)) : null;
    if (title.length < 3) return res.status(400).json({ error: 'Give your event a title (at least 3 characters)' });
    if (isNaN(startsAt) || startsAt.getTime() <= Date.now()) return res.status(400).json({ error: 'Pick a date and time in the future' });
    if (startsAt.getTime() > Date.now() + MAX_EVENT_AHEAD_MS) return res.status(400).json({ error: 'Events can be at most a year ahead' });
    if (capacity !== null && !(capacity >= 2 && capacity <= 1000)) return res.status(400).json({ error: 'Capacity must be between 2 and 1000' });
    const cafe = (await getCafes()).find((c) => c.id === b.cafeId);
    if (!cafe) return res.status(400).json({ error: 'Pick a café for the event' });

    let community = null;
    if (b.communityId) {
      const cid = toId(String(b.communityId));
      community = cid && (await communities.findOne({ _id: cid }));
      if (!community) return res.status(404).json({ error: 'Community not found' });
      if (!(await members.findOne({ _id: `${cid}:${req.user._id}` }))) return res.status(403).json({ error: 'Join the community before hosting an event in it' });
    }

    const now = new Date();
    const doc = {
      title, description, startsAt, capacity,
      cafeId: cafe.id, cafeName: cafe.name,
      communityId: community?._id || null, communityName: community?.name || null,
      createdBy: req.user._id, createdAt: now, goingCount: 1,
    };
    const { insertedId } = await events.insertOne(doc);
    await rsvps.insertOne({ _id: `${insertedId}:${req.user._id}`, eventId: insertedId, userId: req.user._id, createdAt: now });
    res.json({ event: shapeEvent({ ...doc, _id: insertedId }, new Set([String(insertedId)])) });
  });

  router.post('/events/:id/:action(join|leave)', requireUser, async (req, res) => {
    const id = toId(req.params.id);
    const event = id && (await events.findOne({ _id: id }));
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const key = `${id}:${req.user._id}`;
    const already = await rsvps.findOne({ _id: key });

    if (req.params.action === 'join' && !already) {
      // Claim a spot atomically so two people can't take the last place.
      const claimed = await events.findOneAndUpdate(
        { _id: id, $or: [{ capacity: null }, { $expr: { $lt: ['$goingCount', '$capacity'] } }] },
        { $inc: { goingCount: 1 } },
        { returnDocument: 'after' }
      );
      if (!claimed) return res.status(409).json({ error: 'This event is full' });
      try {
        await rsvps.insertOne({ _id: key, eventId: id, userId: req.user._id, createdAt: new Date() });
      } catch (err) {
        await events.updateOne({ _id: id }, { $inc: { goingCount: -1 } });
        if (err.code !== 11000) throw err;
      }
    } else if (req.params.action === 'leave' && already) {
      if (String(event.createdBy) === String(req.user._id)) return res.status(400).json({ error: "You're hosting this event, so you can't leave it" });
      await rsvps.deleteOne({ _id: key });
      await events.updateOne({ _id: id }, { $inc: { goingCount: -1 } });
    }
    const fresh = await events.findOne({ _id: id });
    res.json({ going: req.params.action === 'join', goingCount: fresh.goingCount });
  });

  app.use('/api', router);
}

module.exports = { setupCommunity };
