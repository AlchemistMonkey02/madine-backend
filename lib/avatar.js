const sharp = require('sharp');

const MAX_AVATAR_BYTES = 300 * 1024;
const MAX_AVATAR_DIMENSION = 4096;
const MAX_AVATAR_PIXELS = 16 * 1024 * 1024;
const FORMAT_TO_MIME = { jpeg: 'jpeg', png: 'png', webp: 'webp' };
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

async function decodeAvatar(dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match || !BASE64.test(match[2])) return { error: 'Please choose a JPEG, PNG or WebP image', status: 400 };
  if (match[2].length > Math.ceil(MAX_AVATAR_BYTES / 3) * 4) return { error: 'That photo is too large', status: 413 };
  const source = Buffer.from(match[2], 'base64');
  if (!source.length || source.toString('base64') !== match[2]) return { error: 'Invalid image data', status: 400 };
  if (source.length > MAX_AVATAR_BYTES) return { error: 'That photo is too large', status: 413 };
  try {
    const image = sharp(source, { limitInputPixels: MAX_AVATAR_PIXELS, failOn: 'error' });
    const info = await image.metadata();
    if (FORMAT_TO_MIME[info.format] !== match[1] || !info.width || !info.height ||
        info.width > MAX_AVATAR_DIMENSION || info.height > MAX_AVATAR_DIMENSION ||
        info.width * info.height > MAX_AVATAR_PIXELS || (info.pages || 1) !== 1) {
      return { error: 'Invalid image format or dimensions', status: 400 };
    }
    // Decode every pixel and rewrite the image, removing ancillary metadata.
    const data = await image.rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
    if (data.length > MAX_AVATAR_BYTES) return { error: 'That photo is too large', status: 413 };
    return { data, contentType: 'image/jpeg' };
  } catch {
    return { error: 'That image could not be decoded', status: 400 };
  }
}

module.exports = { decodeAvatar, MAX_AVATAR_BYTES };
