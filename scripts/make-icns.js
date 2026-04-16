/**
 * Generates AppIcon.iconset/ from logo.svg for use with macOS iconutil.
 * Run: node scripts/make-icns.js
 * Then: iconutil -c icns AppIcon.iconset -o icon.icns
 */

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SVG = path.join(__dirname, '..', 'logo.svg');
const ICONSET = path.join(__dirname, '..', 'AppIcon.iconset');

// macOS iconset required sizes
const sizes = [
  { name: 'icon_16x16.png',      size: 16   },
  { name: 'icon_16x16@2x.png',   size: 32   },
  { name: 'icon_32x32.png',      size: 32   },
  { name: 'icon_32x32@2x.png',   size: 64   },
  { name: 'icon_128x128.png',    size: 128  },
  { name: 'icon_128x128@2x.png', size: 256  },
  { name: 'icon_256x256.png',    size: 256  },
  { name: 'icon_256x256@2x.png', size: 512  },
  { name: 'icon_512x512.png',    size: 512  },
  { name: 'icon_512x512@2x.png', size: 1024 },
];

fs.mkdirSync(ICONSET, { recursive: true });

(async () => {
  const svg = fs.readFileSync(SVG);
  for (const { name, size } of sizes) {
    await sharp(svg)
      .resize(size, size)
      .png()
      .toFile(path.join(ICONSET, name));
    console.log(`  ✓ ${name} (${size}x${size})`);
  }
  console.log(`\nIconset ready at AppIcon.iconset/`);
  console.log(`Run: iconutil -c icns AppIcon.iconset -o icon.icns`);
})();
