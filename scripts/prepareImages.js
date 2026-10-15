// Copies every café photo the site actually uses out of the raw dataset
// (DATASET_ROOT, ~1 GB) into public/cafe-images, resized and recompressed for
// the web, so the project can be deployed without the dataset folder.
//
// Paths come straight from the image URLs stored in MongoDB by ingestCafes.js,
// so the files land at exactly the URL the frontend requests (this matters on
// Linux hosts, where paths are case-sensitive). Safe to re-run: skips files
// that already exist unless --force is passed.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { MongoClient } = require('mongodb');

const { MONGODB_URI, MONGODB_DB, MONGODB_COLLECTION, DATASET_ROOT } = process.env;

const OUT_DIR = path.join(__dirname, '..', '..', 'public', 'cafe-images');
const MAX_WIDTH = 1200;
const JPEG_QUALITY = 74;
const force = process.argv.includes('--force');

function sourcePathFor(urlPath) {
  const parts = urlPath.replace(/^\/cafe-images\//, '').split('/').map(decodeURIComponent);
  const exact = path.join(DATASET_ROOT, ...parts);
  if (fs.existsSync(exact)) return { parts, src: exact };
  return { parts, src: null };
}

async function main() {
  if (!DATASET_ROOT || !fs.existsSync(DATASET_ROOT)) {
    throw new Error(`DATASET_ROOT not found: ${DATASET_ROOT}`);
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const docs = await client
    .db(MONGODB_DB)
    .collection(MONGODB_COLLECTION)
    .find({}, { projection: { id: 1, images: 1, menu_local_path: 1 } })
    .toArray();
  await client.close();

  await prepareMenus(docs);

  const urls = [...new Set(docs.flatMap((d) => d.images || []).filter(Boolean))];
  console.log(`Preparing ${urls.length} images -> ${OUT_DIR}`);

  let done = 0, skipped = 0, bytesIn = 0, bytesOut = 0;
  const missing = [];

  for (const url of urls) {
    const { parts, src } = sourcePathFor(url);
    if (!src) { missing.push(url); continue; }

    const dest = path.join(OUT_DIR, ...parts);
    if (!force && fs.existsSync(dest)) { skipped += 1; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    // Output keeps the original extension so the stored URLs stay valid.
    const img = sharp(src).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true });
    const ext = path.extname(dest).toLowerCase();
    if (ext === '.png') await img.png({ compressionLevel: 9, palette: true }).toFile(dest);
    else await img.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toFile(dest);

    bytesIn += fs.statSync(src).size;
    bytesOut += fs.statSync(dest).size;
    done += 1;
    if (done % 100 === 0) console.log(`  ${done} done...`);
  }

  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log('\n--- Image summary ---');
  console.log('Written:', done, `(${mb(bytesIn)} -> ${mb(bytesOut)})`);
  console.log('Already existed (skipped):', skipped);
  console.log('Missing source files:', missing.length);
  missing.slice(0, 5).forEach((u) => console.log('  -', u));
}

// Menu card scans (menu_local_path) -> public/cafe-images/menus/<id>/NN.webp,
// plus a small NN.thumb.webp for the menu grid. Named by café id so the URLs
// never contain the apostrophes/brackets found in the dataset folder names.
const MENU_MAX_WIDTH = 1400;
const MENU_THUMB_WIDTH = 360;

async function prepareMenus(docs) {
  const outRoot = path.join(OUT_DIR, 'menus');
  const withMenus = docs.filter((d) => d.id && d.menu_local_path);
  console.log(`Preparing menu cards for ${withMenus.length} cafés -> ${outRoot}`);
  if (!withMenus.length) {
    console.log('  (no menu_local_path in the database — re-run `npm run ingest` with the updated dataset JSON)');
    return;
  }

  let written = 0, skipped = 0, bytesOut = 0;
  const missing = [];
  for (const doc of withMenus) {
    const rel = doc.menu_local_path.replace(/\\/g, '/').split('/').filter(Boolean);
    let srcDir = path.join(DATASET_ROOT, ...rel);
    if (!fs.existsSync(srcDir)) {
      rel[rel.length - 1] = rel[rel.length - 1].replace(/\.+$/, '');
      srcDir = path.join(DATASET_ROOT, ...rel);
    }
    if (!fs.existsSync(srcDir)) { missing.push(doc.menu_local_path); continue; }

    const files = fs.readdirSync(srcDir)
      .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const destDir = path.join(outRoot, doc.id);
    fs.mkdirSync(destDir, { recursive: true });

    for (let i = 0; i < files.length; i++) {
      const n = String(i + 1).padStart(2, '0');
      const full = path.join(destDir, `${n}.webp`);
      const thumb = path.join(destDir, `${n}.thumb.webp`);
      if (!force && fs.existsSync(full) && fs.existsSync(thumb)) { skipped += 1; continue; }
      const src = path.join(srcDir, files[i]);
      try {
        await sharp(src).rotate().resize({ width: MENU_MAX_WIDTH, withoutEnlargement: true })
          .webp({ quality: 80 }).toFile(full);
        await sharp(src).rotate().resize({ width: MENU_THUMB_WIDTH, withoutEnlargement: true })
          .webp({ quality: 68 }).toFile(thumb);
        bytesOut += fs.statSync(full).size + fs.statSync(thumb).size;
        written += 1;
      } catch (err) {
        missing.push(`${src} (${err.message})`);
      }
      if (written && written % 200 === 0) console.log(`  ${written} menu pages done...`);
    }
  }
  console.log(`Menu pages written: ${written} (${(bytesOut / 1048576).toFixed(1)} MB), skipped: ${skipped}, problems: ${missing.length}`);
  missing.slice(0, 5).forEach((m) => console.log('  -', m));
}

main().catch((err) => {
  console.error('Image preparation failed:', err);
  process.exit(1);
});
