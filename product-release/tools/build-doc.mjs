// Builds the release document HTML (cover + body) and a JSON model for the DOCX generator.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { META, SECTIONS } from './doc-content.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'build');
mkdirSync(BUILD, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ROOT, 'tools', 'capture-manifest.partial.json'), 'utf8'));
const shotInfo = Object.fromEntries(manifest.map((m) => [m.name, m]));
const tocPagesPath = join(BUILD, 'toc-pages.json');
const tocPages = existsSync(tocPagesPath) ? JSON.parse(readFileSync(tocPagesPath, 'utf8')) : {};
const fileUrl = (rel) => pathToFileURL(join(ROOT, rel)).href;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (s) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`(.+?)`/g, '<code>$1</code>')
  .replace(/\[(.+?)\]\(((?:https?:\/\/|mailto:)[^)]+)\)/g, '<a href="$2">$1</a>');

let figNo = 0;
const docModel = { meta: META, sections: [] };

function renderBlock(b, model) {
  switch (b.t) {
    case 'h1': model.title = b.title; model.num = b.num; return `<section class="chapter" id="${b.id}"><div class="chapter-head"><span class="chapter-num">${b.num}</span><h1>${esc(b.title)}</h1></div>`;
    case 'h2': model.blocks.push({ t: 'h2', text: b.text }); return `<h2>${inline(b.text)}</h2>`;
    case 'h3': model.blocks.push({ t: 'h3', text: b.text }); return `<h3>${inline(b.text)}</h3>`;
    case 'p': model.blocks.push(b); return `<p>${inline(b.text)}</p>`;
    case 'lead': model.blocks.push(b); return `<p class="lead">${inline(b.text)}</p>`;
    case 'ul': model.blocks.push(b); return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
    case 'ol': model.blocks.push(b); return `<ol>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ol>`;
    case 'code': model.blocks.push(b); return `<pre class="code">${esc(b.text)}</pre>`;
    case 'note': model.blocks.push(b); return `<div class="note ${b.kind}"><div class="note-title">${esc(b.title)}</div><p>${inline(b.text)}</p></div>`;
    case 'table': {
      model.blocks.push(b);
      const cols = b.widths ? `<colgroup>${b.widths.map((w) => `<col style="width:${w}%">`).join('')}</colgroup>` : '';
      return `<table class="tbl">${cols}<thead><tr>${b.head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    }
    case 'feature': {
      model.blocks.push(b);
      return `<div class="feature"><div class="feature-name">${esc(b.name)}</div>
        <div class="feature-grid"><div><div class="k">What it is</div><p>${inline(b.what)}</p></div><div><div class="k">Why it matters</div><p>${inline(b.why)}</p></div></div>
        <div class="k">How it works</div><ul>${b.how.map((i) => `<li>${inline(i)}</li>`).join('')}</ul></div>`;
    }
    case 'figure': {
      figNo++;
      const info = b.shot ? shotInfo[b.shot] : null;
      if (b.shot && !info) throw new Error(`missing capture for ${b.shot}`);
      const legend = b.legend && info?.annotations?.length ? info.annotations : [];
      if (b.shot && !info.annotations.length) b.src = b.src.replace('Cortextrace_Annotated_Screenshots', 'Cortextrace_Screenshots');
      model.blocks.push({ t: 'figure', src: b.png ?? b.src, caption: `Figure ${figNo}. ${b.caption}`, legend, kind: b.shot ? 'screenshot' : 'diagram' });
      return `<figure class="${b.shot ? 'shot' : 'diagram'} ${b.size}">
        <img src="${fileUrl(b.src)}" alt="${esc(b.caption)}">
        <figcaption><span class="fig-no">Figure ${figNo}</span> ${inline(b.caption)}</figcaption>
        ${legend.length ? `<ol class="legend">${legend.map((a) => `<li><span class="badge">${a.n}</span><span><strong>${esc(a.label ?? '')}</strong>${a.label ? ' — ' : ''}${esc(a.note)}</span></li>`).join('')}</ol>` : ''}
      </figure>`;
    }
    default: throw new Error(`unknown block ${b.t}`);
  }
}

const bodyParts = [];
const toc = [];
for (const sec of SECTIONS) {
  const model = { blocks: [] };
  const html = sec.blocks.map((b) => renderBlock(b, model)).join('\n') + '</section>';
  toc.push({ num: model.num, title: model.title, id: `s${model.num}` });
  docModel.sections.push(model);
  bodyParts.push(html);
}

const CSS = `
@page { size: A4; margin: 22mm 18mm 20mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: #1F2937; font-size: 10pt; line-height: 1.5; }
a { color: #1F5FAF; text-decoration: none; }
code { font-family: 'Cascadia Mono', Consolas, 'SF Mono', monospace; font-size: 8.6pt; background: #F1F4F8; border-radius: 3px; padding: 0 3px; color: #0B1F3A; }
h1 { font-size: 24pt; line-height: 1.12; letter-spacing: -0.02em; color: #0B1F3A; margin: 0; font-weight: 650; }
h2 { font-size: 13.5pt; color: #0B1F3A; margin: 20pt 0 6pt; letter-spacing: -0.01em; font-weight: 650; break-after: avoid; }
h3 { font-size: 11pt; color: #0B1F3A; margin: 14pt 0 4pt; break-after: avoid; }
p { margin: 0 0 7pt; }
.lead { font-size: 12pt; line-height: 1.45; color: #374151; margin-bottom: 12pt; }
ul, ol { margin: 0 0 9pt; padding-left: 16pt; }
li { margin-bottom: 3pt; }
.chapter { break-before: page; }
.chapter-head { display: flex; align-items: baseline; gap: 12pt; border-bottom: 2px solid #0B1F3A; padding-bottom: 8pt; margin-bottom: 14pt; }
.chapter-num { font-size: 24pt; font-weight: 300; color: #1F5FAF; font-variant-numeric: tabular-nums; }
.tbl { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; font-size: 8.9pt; break-inside: auto; }
.tbl th { text-align: left; background: #0B1F3A; color: #fff; font-weight: 600; padding: 5pt 7pt; }
.tbl td { padding: 5pt 7pt; border-bottom: 1px solid #E3E7ED; vertical-align: top; }
.tbl tr { break-inside: avoid; }
.tbl tbody tr:nth-child(even) td { background: #F7F9FB; }
.note { border-left: 3px solid #1F5FAF; background: #EEF3FA; padding: 8pt 11pt; margin: 8pt 0 12pt; border-radius: 0 6px 6px 0; break-inside: avoid; }
.note.warn { border-color: #B45309; background: #FDF6EC; }
.note-title { font-weight: 650; color: #0B1F3A; margin-bottom: 2pt; }
.note p { margin: 0; }
.feature { border: 1px solid #D5DCE5; border-radius: 8px; padding: 10pt 12pt 4pt; margin: 4pt 0 12pt; break-inside: avoid; }
.feature-name { font-size: 12pt; font-weight: 650; color: #0B1F3A; margin-bottom: 6pt; }
.feature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14pt; }
.k { font-size: 7.8pt; text-transform: uppercase; letter-spacing: 0.08em; color: #1F5FAF; font-weight: 700; margin-bottom: 2pt; }
figure { margin: 10pt 0 14pt; break-inside: avoid; }
figure img { width: 100%; display: block; border-radius: 6px; }
figure.shot img { border: 1px solid #D5DCE5; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
figcaption { font-size: 8.6pt; color: #4B5563; margin-top: 5pt; }
.fig-no { font-weight: 650; color: #0B1F3A; }
.legend { list-style: none; padding: 0; margin: 6pt 0 0; display: grid; grid-template-columns: 1fr 1fr; gap: 3pt 14pt; font-size: 8.3pt; color: #374151; }
.legend li { display: flex; gap: 6pt; margin: 0; align-items: flex-start; }
.badge { flex: none; width: 13pt; height: 13pt; border-radius: 50%; background: #0B1F3A; color: #fff; font-size: 7pt; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; margin-top: 1pt; }
pre.code { background: #0F1B2D; color: #E6EDF6; font-family: 'Cascadia Mono', Consolas, monospace; font-size: 8.2pt; padding: 10pt 12pt; border-radius: 6px; white-space: pre-wrap; break-inside: avoid; }
.toc { break-before: page; }
.toc h1 { margin-bottom: 16pt; }
.toc-row { display: flex; align-items: baseline; gap: 8pt; padding: 3.2pt 0; border-bottom: 1px solid #E8ECF1; font-size: 10pt; }
.toc .tbl { font-size: 8.4pt; margin-bottom: 0; }
.toc .tbl td { padding: 3pt 7pt; }
figure.shot.full { width: 90%; margin-left: auto; margin-right: auto; }
.toc-row .n { width: 22pt; color: #1F5FAF; font-variant-numeric: tabular-nums; font-weight: 600; }
.toc-row a { color: #1F2937; flex: 1; }
.toc-row .pg { color: #6B7280; font-variant-numeric: tabular-nums; }
.meta-tbl td:first-child { width: 30%; color: #4B5563; }
`;

const tocHtml = `<section class="toc" id="toc"><div class="chapter-head" style="border-bottom:2px solid #0B1F3A"><h1>Contents</h1></div>
${toc.map((e) => `<div class="toc-row"><span class="n">${e.num}</span><a href="#${e.id}">${esc(e.title)}</a><span class="pg">${tocPages[e.id] ?? ''}</span></div>`).join('')}
<h2 style="margin-top:22pt">Document information</h2>
<table class="tbl meta-tbl"><tbody>
${[['Product', `${META.product} ${META.version}`], ['Release', `${META.release_designation}, ${META.release_date}`], ['Document revision', META.revision], ['Author', META.author], ['License', META.license], ['Distribution', META.classification]].map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
</tbody></table></section>`;

const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(META.title)}</title><style>${CSS}
.toc { break-before: auto; }</style></head><body>${tocHtml}${bodyParts.join('\n')}</body></html>`;
writeFileSync(join(BUILD, 'body.html'), body);

const logo = readFileSync(join(ROOT, '..', 'build', 'logo.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');
const cover = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(META.title)}</title><style>
@page { size: A4; margin: 0; }
html, body { margin: 0; height: 100%; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; background: #0B1F3A; color: #fff; }
.page { position: relative; width: 210mm; height: 297mm; padding: 26mm 22mm; overflow: hidden; }
.top { display: flex; justify-content: space-between; align-items: center; font-size: 9.5pt; color: #AFC3DD; letter-spacing: .06em; text-transform: uppercase; }
.logo { width: 34mm; height: 34mm; margin-top: 46mm; }
.logo svg { width: 100%; height: 100%; }
h1 { font-size: 46pt; letter-spacing: -0.03em; margin: 12mm 0 0; font-weight: 650; line-height: 1; }
.tag { font-size: 16pt; color: #D6E2F1; margin-top: 6mm; max-width: 150mm; line-height: 1.3; font-weight: 300; }
.release { margin-top: 16mm; display: inline-block; border: 1px solid #3A5578; border-radius: 6px; padding: 3mm 5mm; font-size: 11pt; color: #fff; }
.grid { position: absolute; left: 22mm; right: 22mm; bottom: 24mm; display: grid; grid-template-columns: repeat(3, 1fr); gap: 5mm 10mm; font-size: 9pt; border-top: 1px solid #2B4466; padding-top: 7mm; }
.grid .k { color: #8FA7C4; text-transform: uppercase; letter-spacing: .08em; font-size: 7.4pt; margin-bottom: 1mm; }
.grid .v { color: #fff; }
.arc { position: absolute; right: -60mm; top: 40mm; width: 170mm; height: 170mm; border-radius: 50%; border: 18mm solid rgba(57,135,229,0.10); }
</style></head><body><div class="page"><div class="arc"></div>
<div class="top"><span>${esc(META.company)}</span><span>Product Release Document</span></div>
<div class="logo">${logo}</div>
<h1>${esc(META.product)}</h1>
<div class="tag">${esc(META.tagline)}</div>
<div class="release">${esc(META.release_designation)} · Version ${esc(META.version)} · ${esc(META.release_date)}</div>
<div class="grid">
${[['Company', META.company], ['Website', META.website], ['Contact', META.email], ['Maintainer', META.founder], ['Repository', META.github.replace('https://', '')], ['License', 'Apache License 2.0']].map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}
</div></div></body></html>`;
writeFileSync(join(BUILD, 'cover.html'), cover);
writeFileSync(join(BUILD, 'doc-model.json'), JSON.stringify({ ...docModel, toc }, null, 2));
console.log(`html built: ${toc.length} sections, ${figNo} figures${Object.keys(tocPages).length ? ' (with page numbers)' : ''}`);
