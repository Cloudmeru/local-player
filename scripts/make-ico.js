/**
 * Generates icon.ico from logo.svg with all Windows icon sizes embedded.
 * Each size is rendered fresh from the SVG vector source via sharp — never
 * downscaled from a raster, so every size is pixel-perfect.
 *
 * The ICO is written in PNG-in-ICO format (supported since Windows Vista),
 * which preserves full alpha and avoids any bitmap lossy conversion.
 *
 * Run: node scripts/make-ico.js
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SVG = path.join(__dirname, '..', 'logo.svg');
const OUT = path.join(__dirname, '..', 'icon.ico');

// Windows picks the exact size for each context — all must be present
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  // ICO header: 6 bytes
  // ICO directory: 16 bytes × count
  // Then PNG data
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // reserved
  header.writeUInt16LE(1, 2);     // type: ICO
  header.writeUInt16LE(count, 4); // image count

  const dirEntries = [];
  let dataOffset = 6 + 16 * count;

  for (const buf of pngBuffers) {
    // Read actual dimensions from PNG header (bytes 16-23)
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(w >= 256 ? 0 : w, 0);   // width  (0 = 256)
    entry.writeUInt8(h >= 256 ? 0 : h, 1);   // height (0 = 256)
    entry.writeUInt8(0, 2);                   // color count
    entry.writeUInt8(0, 3);                   // reserved
    entry.writeUInt16LE(1, 4);                // color planes
    entry.writeUInt16LE(32, 6);               // bits per pixel
    entry.writeUInt32LE(buf.length, 8);       // size of image data
    entry.writeUInt32LE(dataOffset, 12);      // offset to image data
    dirEntries.push(entry);
    dataOffset += buf.length;
  }

  return Buffer.concat([header, ...dirEntries, ...pngBuffers]);
}

(async () => {
  const svg = fs.readFileSync(SVG);

  // Render each size directly from SVG — fresh vector render, not a downscale
  const pngBuffers = await Promise.all(
    SIZES.map((size) =>
      sharp(svg)
        .resize(size, size)
        .png()
        .toBuffer()
        .then((buf) => { console.log(`  ✓ ${size}×${size} (SVG → PNG, ${buf.length} bytes)`); return buf; })
    )
  );

  const ico = buildIco(pngBuffers);
  fs.writeFileSync(OUT, ico);
  console.log(`\n✓ icon.ico written — ${(ico.length / 1024).toFixed(1)} KB, ${SIZES.length} sizes embedded`);
})();
