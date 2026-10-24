const { promisify } = require('node:util');
const { gzip } = require('node:zlib');
const { createHash } = require('node:crypto');
const compress = promisify(gzip);

// Share JSON serialization and compression for the current catalog snapshot.
// A newly approved listing creates a new array and therefore a new response.
function createCatalogResponseCache() {
  const snapshots = new WeakMap();
  return function responseFor(cafes) {
    if (!snapshots.has(cafes)) {
      const pending = (async () => {
        const json = JSON.stringify({ count: cafes.length, cafes });
        return { json, gzip: await compress(json), etag: 'W/"' + createHash('sha256').update(json).digest('hex') + '"' };
      })().catch((error) => { snapshots.delete(cafes); throw error; });
      snapshots.set(cafes, pending);
    }
    return snapshots.get(cafes);
  };
}

module.exports = { createCatalogResponseCache };
