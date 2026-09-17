// Prints cover.html and body.html to PDF with Chromium (embedded fonts, vector diagrams, internal links, header/footer).
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const BUILD = join(__dirname, '..', 'build');
const header = `<div style="width:100%;font-family:'Segoe UI',Arial,sans-serif;font-size:7.5pt;color:#6B7280;padding:0 18mm;display:flex;justify-content:space-between;">
<span>Cortextrace 0.1.0 · Product Release Document</span><span>Public · Revision 1.0</span></div>`;
const footer = `<div style="width:100%;font-family:'Segoe UI',Arial,sans-serif;font-size:7.5pt;color:#6B7280;padding:0 18mm;display:flex;justify-content:space-between;">
<span>© 2026 Manjunatha M, AI and ML consultants · Apache License 2.0</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

let w;
async function print(file, out, opts) {
  w ??= new BrowserWindow({ show: false });
  await w.loadFile(join(BUILD, file));
  await w.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; }))).then(() => document.fonts.ready).then(() => true)');
  const pdf = await w.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, generateDocumentOutline: true, ...opts });
  writeFileSync(join(BUILD, out), pdf);
  console.log('printed', out, pdf.length);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  await print('cover.html', 'cover.pdf', { displayHeaderFooter: false });
  await print('body.html', 'body.pdf', { displayHeaderFooter: true, headerTemplate: header, footerTemplate: footer });
  app.quit();
});
