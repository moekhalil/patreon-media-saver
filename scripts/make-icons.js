// Renders src/assets/icon.svg into PNGs + a multi-size Windows .ico.
// Usage: npm run icons   (runs this with Electron so we can rasterize the SVG via Chromium)
//
// Outputs:
//   src/assets/icon.png   512px (window/taskbar icon at runtime)
//   build/icon.png        512px (electron-builder fallback / other platforms)
//   build/icon.ico        16, 24, 32, 48, 64, 128, 256 px (electron-builder Windows icon)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'src', 'assets', 'icon.svg');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Build an .ico whose entries are PNG-compressed images (supported since Windows Vista). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // 0 means 256
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('about:blank');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const sizes = [...ICO_SIZES, 512];
  // Rasterize in the page with canvas (crisp vector rendering at each size).
  const dataUrls = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(svg)};
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const out = {};
    for (const s of ${JSON.stringify(sizes)}) {
      const c = document.createElement('canvas');
      c.width = c.height = s;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, s, s);
      out[s] = c.toDataURL('image/png');
    }
    return out;
  })()`);
  const png = (s) => Buffer.from(dataUrls[s].split(',')[1], 'base64');

  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'assets', 'icon.png'), png(512));
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png(512));
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), buildIco(ICO_SIZES.map((size) => ({ size, data: png(size) }))));
  console.log('Wrote src/assets/icon.png, build/icon.png, build/icon.ico');
  app.exit(0);
});
