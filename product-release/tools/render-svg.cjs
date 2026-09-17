// Renders the architecture SVGs to 2x PNG with Chromium (arrowheads and fonts exactly as in the PDF).
// Run: npx electron product-release/tools/render-svg.cjs
const { app, BrowserWindow } = require('electron');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const dir = join(__dirname, '..', 'Cortextrace_Architecture_Diagrams');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('about:blank');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.svg'))) {
    const svg = readFileSync(join(dir, f), 'utf8');
    const [, width, height] = /width="(\d+)" height="(\d+)"/.exec(svg);
    const url = await w.webContents.executeJavaScript(`new Promise((res, rej) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = ${width} * 2; c.height = ${height} * 2; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(i, 0, 0, c.width, c.height); res(c.toDataURL('image/png')); }; i.onerror = rej; i.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}'; })`);
    writeFileSync(join(dir, f.replace('.svg', '.png')), Buffer.from(url.split(',')[1], 'base64'));
    console.log('rendered', f);
  }
  app.quit();
});
