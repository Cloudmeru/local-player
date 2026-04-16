/**
 * Generates icon.png (512x512) from logo.svg for use on Linux.
 * Rendered directly from the SVG vector source via sharp.
 * Run: node scripts/make-png.js
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SVG = path.join(__dirname, '..', 'logo.svg');
const OUT = path.join(__dirname, '..', 'icon.png');

sharp(fs.readFileSync(SVG))
  .resize(512, 512)
  .png()
  .toFile(OUT)
  .then((info) => console.log(`✓ icon.png written — ${info.width}×${info.height}`));
