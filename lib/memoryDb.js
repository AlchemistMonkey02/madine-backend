const { ObjectId } = require('mongodb');

/**
 * Lightweight in-memory MongoDB-compatible database adapter.
 * Used automatically when MONGODB_URI is not provided, allowing
 * the entire backend to run standalone with zero external dependencies.
 */

function matchQuery(doc, query = {}) {
  if (!query || Object.keys(query).length === 0) return true;

  for (const [key, expected] of Object.entries(query)) {
    if (key === '$or' && Array.isArray(expected)) {
      if (!expected.some((subQuery) => matchQuery(doc, subQuery))) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(expected)) {
      if (!expected.every((subQuery) => matchQuery(doc, subQuery))) return false;
      continue;
    }

    const val = doc[key];
    if (expected && typeof expected === 'object' && !(expected instanceof ObjectId) && !(expected instanceof Date)) {
      if ('$in' in expected && Array.isArray(expected.$in)) {
        const list = expected.$in.map(String);
        if (Array.isArray(val)) {
          if (!val.some((v) => list.includes(String(v)))) return false;
        } else if (!list.includes(String(val))) {
          return false;
        }
      }
      if ('$nin' in expected && Array.isArray(expected.$nin)) {
        const list = expected.$nin.map(String);
        if (list.includes(String(val))) return false;
      }
      if ('$exists' in expected) {
        const exists = key in doc && doc[key] !== undefined;
        if (Boolean(expected.$exists) !== exists) return false;
      }
      if ('$gt' in expected && !(val > expected.$gt)) return false;
      if ('$gte' in expected && !(val >= expected.$gte)) return false;
      if ('$lt' in expected && !(val < expected.$lt)) return false;
      if ('$lte' in expected && !(val <= expected.$lte)) return false;
      if ('$ne' in expected && String(val) === String(expected.$ne)) return false;
      continue;
    }

    // Direct equality (compare as strings for ObjectIds / primitives)
    if (String(val) !== String(expected)) return false;
  }

  return true;
}

class MemoryCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
  }

  async createIndex() {
    return true;
  }

  find(query = {}, projection = {}) {
    const matched = this.docs.filter((doc) => matchQuery(doc, query));
    let result = matched.map((d) => ({ ...d }));

    const cursor = {
      toArray: async () => result,
      sort: (sortObj = {}) => {
        const [field, dir] = Object.entries(sortObj)[0] || [];
        if (field) {
          result.sort((a, b) => {
            const va = a[field];
            const vb = b[field];
            if (va < vb) return dir === -1 ? 1 : -1;
            if (va > vb) return dir === -1 ? -1 : 1;
            return 0;
          });
        }
        return cursor;
      },
      limit: (n) => {
        result = result.slice(0, n);
        return cursor;
      },
    };
    return cursor;
  }

  async findOne(query = {}) {
    const doc = this.docs.find((d) => matchQuery(d, query));
    return doc ? { ...doc } : null;
  }

  async insertOne(doc) {
    const toInsert = {
      _id: doc._id || new ObjectId(),
      createdAt: doc.createdAt || new Date(),
      ...doc,
    };
    this.docs.push(toInsert);
    return { insertedId: toInsert._id, acknowledged: true };
  }

  async updateOne(filter, update, options = {}) {
    const idx = this.docs.findIndex((d) => matchQuery(d, filter));
    if (idx === -1) {
      if (options.upsert) {
        const toInsert = {
          _id: new ObjectId(),
          ...(filter.id ? { id: filter.id } : {}),
          ...(update.$set || {}),
        };
        this.docs.push(toInsert);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: toInsert._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }

    const doc = this.docs[idx];
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        doc[k] = (doc[k] || 0) + v;
      }
    }
    if (update.$addToSet) {
      for (const [k, v] of Object.entries(update.$addToSet)) {
        if (!Array.isArray(doc[k])) doc[k] = [];
        if (!doc[k].some((item) => String(item) === String(v))) {
          doc[k].push(v);
        }
      }
    }
    if (update.$pull) {
      for (const [k, v] of Object.entries(update.$pull)) {
        if (Array.isArray(doc[k])) {
          doc[k] = doc[k].filter((item) => String(item) !== String(v));
        }
      }
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter, update) {
    let count = 0;
    for (const doc of this.docs) {
      if (matchQuery(doc, filter)) {
        if (update.$set) Object.assign(doc, update.$set);
        count++;
      }
    }
    return { matchedCount: count, modifiedCount: count };
  }

  async deleteOne(filter) {
    const idx = this.docs.findIndex((d) => matchQuery(d, filter));
    if (idx !== -1) {
      this.docs.splice(idx, 1);
      return { deletedCount: 1 };
    }
    return { deletedCount: 0 };
  }

  async deleteMany(filter = {}) {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => !matchQuery(d, filter));
    return { deletedCount: before - this.docs.length };
  }

  async countDocuments(query = {}) {
    return this.docs.filter((d) => matchQuery(d, query)).length;
  }

  async aggregate(pipeline = []) {
    let result = [...this.docs];
    for (const stage of pipeline) {
      if (stage.$match) {
        result = result.filter((d) => matchQuery(d, stage.$match));
      }
      if (stage.$sort) {
        const [field, dir] = Object.entries(stage.$sort)[0] || [];
        if (field) {
          result.sort((a, b) => {
            if (a[field] < b[field]) return dir === -1 ? 1 : -1;
            if (a[field] > b[field]) return dir === -1 ? -1 : 1;
            return 0;
          });
        }
      }
      if (stage.$limit) {
        result = result.slice(0, stage.$limit);
      }
    }
    return result;
  }
}

class MemoryDatabase {
  constructor() {
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MemoryCollection(name));
    }
    return this.collections.get(name);
  }
}

function createMemoryDb() {
  return new MemoryDatabase();
}

module.exports = { createMemoryDb, MemoryDatabase };
