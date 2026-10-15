// Reads the Jaipur cafe dataset JSON, resolves image paths to web-servable URLs,
// and upserts all records into MongoDB (madine.madine_core).
// Safe to re-run: matches existing docs by their dataset `id` and updates them.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const {
  MONGODB_URI,
  MONGODB_DB,
  MONGODB_COLLECTION,
  DATASET_JSON_PATH,
  DATASET_ROOT,
} = process.env;

const IMAGE_FIELDS = ['image_01', 'image_02', 'image_03', 'image_04', 'image_05'];

function loadSanitizedJson(filePath) {
  let raw = fs.readFileSync(filePath, 'utf8');
  // The source export (pandas/Python) writes invalid JSON tokens for missing
  // numeric values. Replace them with null before parsing.
  raw = raw.replace(/:\s*NaN/g, ': null').replace(/:\s*-?Infinity/g, ': null');
  return JSON.parse(raw);
}

// Converts a dataset-relative Windows path like
//   "JAIPUR_CAFE_DATASET\Batch_01\images\JPR-001_Handi_Restaurant\ambience_01.jpg"
// into a web URL path served by the backend's static route:
//   "/cafe-images/Batch_01/images/JPR-001_Handi_Restaurant/ambience_01.jpg"
// Returns null if the field is empty or the file doesn't actually exist on disk.
function resolveImageUrl(relPath, missingList) {
  if (!relPath || typeof relPath !== 'string' || !relPath.trim()) return null;

  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  // Drop a leading "JAIPUR_CAFE_DATASET" segment if present, since DATASET_ROOT
  // already points at that folder.
  if (parts[0] === 'JAIPUR_CAFE_DATASET') parts.shift();

  let absolutePath = path.join(DATASET_ROOT, ...parts);

  if (!fs.existsSync(absolutePath)) {
    // Windows silently strips trailing periods from folder names (e.g. a
    // dataset folder named "..._Co." gets created on disk as "..._Co").
    // Retry with that segment trimmed before giving up.
    const trimmedParts = [...parts];
    const folderIdx = trimmedParts.length - 2; // the cafe folder, one above the filename
    if (folderIdx >= 0 && trimmedParts[folderIdx].endsWith('.')) {
      trimmedParts[folderIdx] = trimmedParts[folderIdx].replace(/\.+$/, '');
      const retryPath = path.join(DATASET_ROOT, ...trimmedParts);
      if (fs.existsSync(retryPath)) {
        absolutePath = retryPath;
        parts.splice(folderIdx, 1, trimmedParts[folderIdx]);
      }
    }
  }

  if (!fs.existsSync(absolutePath)) {
    missingList.push(absolutePath);
    return null;
  }
  const relativeUrl = '/cafe-images/' + parts.join('/');
  return relativeUrl;
}

function transformRecord(record, missingList) {
  const images = [];
  const out = { ...record };

  for (const field of IMAGE_FIELDS) {
    const url = resolveImageUrl(record[field], missingList);
    out[field] = url;
    if (url) images.push(url);
  }
  out.images = images; // convenient array for the frontend to iterate
  return out;
}

async function main() {
  console.log('Reading dataset:', DATASET_JSON_PATH);
  const rawRecords = loadSanitizedJson(DATASET_JSON_PATH);
  console.log(`Loaded ${rawRecords.length} records from JSON.`);

  const missingImages = [];
  const records = rawRecords.map((r) => transformRecord(r, missingImages));

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  console.log('Connected to MongoDB.');

  const db = client.db(MONGODB_DB);
  const collection = db.collection(MONGODB_COLLECTION);

  await collection.createIndex({ id: 1 }, { unique: true });

  let inserted = 0;
  let updated = 0;

  for (const record of records) {
    const result = await collection.updateOne(
      { id: record.id },
      { $set: record },
      { upsert: true }
    );
    if (result.upsertedCount > 0) inserted += 1;
    else if (result.modifiedCount > 0) updated += 1;
  }

  const totalInDb = await collection.countDocuments();

  console.log('\n--- Ingestion summary ---');
  console.log('Records processed:', records.length);
  console.log('Newly inserted:', inserted);
  console.log('Updated (already existed):', updated);
  console.log('Unchanged:', records.length - inserted - updated);
  console.log('Total documents now in', `${MONGODB_DB}.${MONGODB_COLLECTION}:`, totalInDb);
  console.log('Missing image files referenced by JSON but not found on disk:', missingImages.length);
  if (missingImages.length > 0) {
    console.log('First few missing paths:');
    missingImages.slice(0, 5).forEach((p) => console.log('  -', p));
  }

  await client.close();
}

main().catch((err) => {
  console.error('Ingestion failed:', err);
  process.exit(1);
});
