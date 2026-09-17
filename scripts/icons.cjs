// Rasterises build/logo.svg into app and tray icons using Electron's own renderer (no image dependencies).
// Run: npx electron scripts/icons.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const logo = readFileSync(join(root, 'build', 'logo.svg'), 'utf8');
// Tray glyph: the mark without the tile, single colour so macOS can template it.
const glyph = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><path d="M 760 280 A 330 330 0 1 0 760 744" fill="none" stroke="${color}" stroke-width="120" stroke-linecap="round"/><circle cx="760" cy="744" r="100" fill="${color}"/><circle cx="512" cy="512" r="110" fill="${color}"/></svg>`;

let w;
async function render(svg, size) {
  // Render large on a canvas inside the page and export PNG bytes: independent of window paint/capture.
  const dataUrl = await w.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size};
      c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size}); resolve(c.toDataURL('image/png')); };
    img.onerror = () => reject(new Error('svg load failed'));
    img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  w = new BrowserWindow({ width: 200, height: 200, show: false });
  await w.loadURL('about:blank');
  writeFileSync(join(root, 'build', 'icon.png'), await render(logo, 1024));
  writeFileSync(join(root, 'build', 'tray.png'), await render(glyph('#3987e5'), 32));
  writeFileSync(join(root, 'build', 'trayTemplate.png'), await render(glyph('#000000'), 22));
  writeFileSync(join(root, 'build', 'trayTemplate@2x.png'), await render(glyph('#000000'), 44));
  console.log('icons written to build/');
  app.quit();
});
