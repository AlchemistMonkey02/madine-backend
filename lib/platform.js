const express = require('express');
const { asyncRouter } = require('./http');
const { selfProfile, isPlatformAdmin } = require('./profile');
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const publicCafeId = (doc) => doc.existingCafeId || 'cafe-' + doc._id;
const safeUrl = (value) => {
  if (!value) return '';
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
};

function approvedCafeView(doc, base) {
  const d = doc.publishedDetails;
  if (!d) return base || null;
  const cafe = base || { id: publicCafeId(doc), slug: publicCafeId(doc), priceRange: '₹₹', cafeType: ['Cafe'], ambience: ['Cozy'], topFoods: [], image: null, gallery: [], rating: null, reviews: 0, menu: [], menuImages: [], menuCategories: [], features: [], links: {}, featured: false, trending: false };
  return { ...cafe, name: d.name, description: d.description, about: d.description, hours: d.hours || cafe.hours,
    location: { ...cafe.location, area: d.area, address: d.address, city: 'Jaipur' },
    cuisines: d.cuisines.length ? d.cuisines : cafe.cuisines || ['Cafe'],
    links: { ...cafe.links, website: d.website, maps: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(d.name + ', ' + d.address) },
    ownerManaged: true };
}

async function setupPlatform(app, db, { requireUser, requireProfile, getCafes, invalidateCafeCache, toId, notify }) {
  const users = db.collection('users'), submissions = db.collection('cafe_submissions');
  const posts = db.collection('feed_posts'), likes = db.collection('feed_likes'), comments = db.collection('feed_comments');
  const reviews = db.collection('cafe_reviews'), notifications = db.collection('notifications');
  const communities = db.collection('communities'), members = db.collection('community_members');
  await Promise.all([
    submissions.createIndex({ ownerId: 1, updatedAt: -1 }), submissions.createIndex({ status: 1, updatedAt: -1 }),
    submissions.createIndex({ existingCafeId: 1 }, { unique: true, partialFilterExpression: { existingCafeId: { $type: 'string' } } }),
    posts.createIndex({ createdAt: -1 }), posts.createIndex({ communityId: 1, createdAt: -1 }),
    likes.createIndex({ postId: 1 }), comments.createIndex({ postId: 1, createdAt: 1 }),
    reviews.createIndex({ cafeId: 1, userId: 1 }, { unique: true }), notifications.createIndex({ userId: 1, createdAt: -1 }),
  ]);
  async function pushNotification(userId, { title, body = '', href = '#home', type = 'activity' }) {
    await notifications.insertOne({ userId, title: text(title, 120), body: text(body, 500), href, type, createdAt: new Date(), readAt: null });
    notify(userId, 'notifications:changed', {});
  }
  const requireOwner = (req, res, next) => req.user?.accountType === 'cafe_owner' ? next() : res.status(403).json({ error: 'A café owner account is required' });
  const requireAdmin = (req, res, next) => isPlatformAdmin(req.user) ? next() : res.status(403).json({ error: 'Admin access is required' });
  const router = asyncRouter();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const shapeSubmission = (doc) => ({ id: String(doc._id), cafeId: publicCafeId(doc), existingCafeId: doc.existingCafeId || '', details: doc.details, status: doc.status, revision: doc.revision, reviewNote: doc.reviewNote || '', published: !!doc.publishedDetails, updatedAt: doc.updatedAt });
  function readDetails(body) {
    const d = { contactName: text(body.contactName, 60), name: text(body.name, 100), area: text(body.area, 80), address: text(body.address, 300), description: text(body.description, 1600), hours: text(body.hours, 120), phone: text(body.phone, 40), website: safeUrl(body.website), cuisines: text(body.cuisines, 160).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 8) };
    return d.contactName.length >= 2 && d.name.length >= 2 && d.area && d.address && d.description ? d : null;
  }
  router.put('/me/account-type', requireUser, express.json({ limit: '1kb' }), async (req, res) => {
    const type = req.body?.accountType;
    if (type !== 'customer') return res.status(400).json({ error: 'Only customer signup is available' });
    const result = await users.findOneAndUpdate({ _id: req.user._id, $or: [{ accountType: { $exists: false } }, { accountType: null }, { accountType: type }] }, { $set: { accountType: type } }, { returnDocument: 'after' });
    if (!result) return res.status(409).json({ error: 'Your account type has already been selected' });
    res.json({ user: selfProfile(result) });
  });
  router.get('/owner/cafes', requireUser, requireOwner, async (req, res) => {
    res.json({ cafes: (await submissions.find({ ownerId: req.user._id }).sort({ updatedAt: -1 }).toArray()).map(shapeSubmission) });
  });
  router.post('/owner/cafes', requireUser, requireOwner, express.json({ limit: '10kb' }), async (req, res) => {
    const details = readDetails(req.body || {});
    if (!details) return res.status(400).json({ error: 'Add your name, café name, area, address and description' });
    const existingCafeId = text(req.body.existingCafeId, 80);
    if (existingCafeId && !(await getCafes()).some((c) => c.id === existingCafeId)) return res.status(400).json({ error: 'Choose an existing café from the list' });
    const now = new Date(), doc = { ownerId: req.user._id, details, status: 'pending', revision: 1, createdAt: now, updatedAt: now };
    if (existingCafeId) doc.existingCafeId = existingCafeId;
    try { doc._id = (await submissions.insertOne(doc)).insertedId; }
    catch (err) { if (err.code === 11000) return res.status(409).json({ error: 'That café already has an ownership application' }); throw err; }
    if (!req.user.name) await users.updateOne({ _id: req.user._id }, { $set: { name: details.contactName } });
    await pushNotification(req.user._id, { title: 'Café submitted for review', body: details.name + ' is awaiting admin approval.', href: '#business' });
    res.status(201).json({ cafe: shapeSubmission(doc), user: selfProfile(await users.findOne({ _id: req.user._id })) });
  });
  router.put('/owner/cafes/:id', requireUser, requireOwner, express.json({ limit: '10kb' }), async (req, res) => {
    const id = toId(req.params.id), details = readDetails(req.body || {});
    if (!id || !details) return res.status(400).json({ error: 'Complete all required café details' });
    const doc = await submissions.findOneAndUpdate({ _id: id, ownerId: req.user._id }, { $set: { details, status: 'pending', reviewNote: '', updatedAt: new Date() }, $inc: { revision: 1 } }, { returnDocument: 'after' });
    if (!doc) return res.status(404).json({ error: 'Café application not found' });
    res.json({ cafe: shapeSubmission(doc) });
  });
  router.get('/admin/cafes', requireUser, requireAdmin, async (req, res) => {
    res.json({ cafes: (await submissions.find({}).sort({ updatedAt: -1 }).limit(200).toArray()).map(shapeSubmission) });
  });
  router.post('/admin/cafes/:id/review', requireUser, requireAdmin, express.json({ limit: '2kb' }), async (req, res) => {
    const id = toId(req.params.id), decision = req.body?.decision, note = text(req.body?.note, 500), revision = Number(req.body?.revision);
    if (!id || !['approved', 'changes_requested', 'rejected'].includes(decision) || !Number.isInteger(revision)) return res.status(400).json({ error: 'Choose a valid review decision and revision' });
    if (decision !== 'approved' && !note) return res.status(400).json({ error: 'Explain the changes needed or reason for rejection' });
    const before = await submissions.findOne({ _id: id, status: 'pending', revision });
    if (!before) return res.status(409).json({ error: 'This application changed or has already been reviewed. Reload it.' });
    const update = { status: decision, reviewNote: note, reviewedBy: req.user._id, reviewedAt: new Date(), updatedAt: new Date() };
    if (decision === 'approved') update.publishedDetails = before.details;
    const doc = await submissions.findOneAndUpdate({ _id: id, status: 'pending', revision }, { $set: update }, { returnDocument: 'after' });
    if (!doc) return res.status(409).json({ error: 'The application changed during review' });
    invalidateCafeCache();
    await pushNotification(doc.ownerId, { title: decision === 'approved' ? 'Your café is approved' : decision === 'changes_requested' ? 'Changes requested for your café' : 'Café application rejected', body: note || doc.details.name, href: '#business', type: 'cafe_review' });
    res.json({ cafe: shapeSubmission(doc) });
  });
  const canParticipate = async (post, userId) => !!post.communityId && !!await members.findOne({ _id: post.communityId + ':' + userId });
  router.get('/feed', async (req, res) => {
    const filter = {};
    if (!req.query.communityId) return res.status(404).json({ error: 'Open a group to view its discussions' });
    if (req.query.communityId) { const id = toId(String(req.query.communityId)); if (!id) return res.status(400).json({ error: 'Invalid community' }); filter.communityId = id; }
    if (req.query.postId) { const id = toId(String(req.query.postId)); if (!id) return res.status(400).json({ error: 'Invalid post' }); filter._id = id; }
    const list = await posts.find(filter).sort({ createdAt: -1 }).limit(50).toArray(), ids = list.map((p) => p._id);
    const authorIds = [...new Map(list.map((p) => [String(p.authorId), p.authorId])).values()];
    const authors = authorIds.length ? await users.find({ _id: { $in: authorIds } }).project({ name: 1 }).toArray() : [];
    const authorNames = Object.fromEntries(authors.map((u) => [String(u._id), u.name]));
    const [likeRows, commentRows, mine] = ids.length ? await Promise.all([
      likes.aggregate([{ $match: { postId: { $in: ids } } }, { $group: { _id: '$postId', count: { $sum: 1 } } }]).toArray(),
      comments.aggregate([{ $match: { postId: { $in: ids } } }, { $group: { _id: '$postId', count: { $sum: 1 } } }]).toArray(),
      req.user ? likes.find({ postId: { $in: ids }, userId: req.user._id }).toArray() : [],
    ]) : [[], [], []];
    const likeCounts = Object.fromEntries(likeRows.map((r) => [String(r._id), r.count])), commentCounts = Object.fromEntries(commentRows.map((r) => [String(r._id), r.count])), liked = new Set(mine.map((l) => String(l.postId)));
    res.json({ posts: list.map((p) => ({ id: String(p._id), authorName: authorNames[String(p.authorId)] || 'MADINE member', text: p.text, type: p.type, cafeId: p.cafeId, cafeName: p.cafeName, communityId: p.communityId ? String(p.communityId) : null, communityName: p.communityName, createdAt: p.createdAt, likes: likeCounts[String(p._id)] || 0, comments: commentCounts[String(p._id)] || 0, liked: liked.has(String(p._id)) })) });
  });
  router.post('/feed', requireUser, requireProfile, express.json({ limit: '5kb' }), async (req, res) => {
    const body = text(req.body?.text, 2000);
    if (body.length < 3) return res.status(400).json({ error: 'Write at least 3 characters' });
    if (req.body?.cafeId || req.body?.type === 'offer') return res.status(400).json({ error: 'Public posts and offers are no longer available' });
    const communityId = req.body?.communityId ? toId(String(req.body.communityId)) : null;
    if (!communityId) return res.status(400).json({ error: 'Choose a group for your discussion' });
    const group = await communities.findOne({ _id: communityId });
    if (!group || !await members.findOne({ _id: communityId + ':' + req.user._id })) return res.status(403).json({ error: 'Join the community to start a discussion' });
    const result = await posts.insertOne({ authorId: req.user._id, text: body, type: 'post', communityId, communityName: group.name, createdAt: new Date() });
    res.status(201).json({ id: String(result.insertedId) });
  });
  router.post('/feed/:id/like', requireUser, express.json({ limit: '1kb' }), async (req, res) => {
    const id = toId(req.params.id), post = id && await posts.findOne({ _id: id });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!await canParticipate(post, req.user._id)) return res.status(403).json({ error: 'Join this community to participate' });
    const key = id + ':' + req.user._id, liked = req.body?.liked === true;
    if (liked) {
      const result = await likes.updateOne({ _id: key }, { $setOnInsert: { _id: key, postId: id, userId: req.user._id } }, { upsert: true });
      if (result.upsertedCount && String(post.authorId) !== String(req.user._id)) await pushNotification(post.authorId, { title: (req.user.name || 'A MADINE member') + ' liked your discussion', href: '#discussion/' + post.communityId + '/' + id });
    }
    else await likes.deleteOne({ _id: key });
    res.json({ liked, likes: await likes.countDocuments({ postId: id }) });
  });
  router.get('/feed/:id/comments', async (req, res) => {
    const id = toId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid post' });
    if (!await posts.findOne({ _id: id, communityId: { $ne: null } })) return res.status(404).json({ error: 'Discussion not found' });
    const rows = await comments.find({ postId: id }).sort({ createdAt: 1 }).limit(100).toArray();
    res.json({ comments: rows.map((c) => ({ id: String(c._id), name: c.authorName, text: c.text, createdAt: c.createdAt })) });
  });
  router.post('/feed/:id/comments', requireUser, requireProfile, express.json({ limit: '2kb' }), async (req, res) => {
    const id = toId(req.params.id), body = text(req.body?.text, 1000), post = id && await posts.findOne({ _id: id });
    if (!post || !body) return res.status(400).json({ error: 'Choose a post and write a comment' });
    if (!await canParticipate(post, req.user._id)) return res.status(403).json({ error: 'Join this community to participate' });
    await comments.insertOne({ postId: id, authorId: req.user._id, authorName: req.user.name, text: body, createdAt: new Date() });
    if (String(post.authorId) !== String(req.user._id)) await pushNotification(post.authorId, { title: req.user.name + ' replied to your discussion', body, href: '#discussion/' + post.communityId + '/' + id });
    res.status(201).json({ ok: true });
  });
  router.get('/cafes/:id/reviews', async (req, res) => {
    const rows = await reviews.find({ cafeId: req.params.id }).sort({ updatedAt: -1 }).limit(50).toArray();
    res.json({ reviews: rows.map((r) => ({ id: String(r._id), name: r.authorName, rating: r.rating, text: r.text, mine: req.user && String(r.userId) === String(req.user._id), updatedAt: r.updatedAt })) });
  });
  router.post('/cafes/:id/reviews', requireUser, requireProfile, express.json({ limit: '3kb' }), async (req, res) => {
    const cafeId = req.params.id, rating = Number(req.body?.rating), body = text(req.body?.text, 1200);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !body) return res.status(400).json({ error: 'Choose 1–5 stars and write your review' });
    if (!(await getCafes()).some((c) => c.id === cafeId)) return res.status(404).json({ error: 'Café not found' });
    await reviews.updateOne({ cafeId, userId: req.user._id }, { $set: { authorName: req.user.name, rating, text: body, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  });
  router.get('/notifications', requireUser, async (req, res) => {
    const list = await notifications.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ notifications: list.map((n) => ({ id: String(n._id), title: n.title, body: n.body, href: n.href, read: !!n.readAt, createdAt: n.createdAt })), unread: await notifications.countDocuments({ userId: req.user._id, readAt: null }) });
  });
  router.put('/notifications/read', requireUser, express.json({ limit: '1kb' }), async (req, res) => {
    await notifications.updateMany({ userId: req.user._id, readAt: null }, { $set: { readAt: new Date() } });
    res.json({ ok: true });
  });
  app.use('/api', router);
  return { pushNotification };
}
module.exports = { setupPlatform, approvedCafeView };
