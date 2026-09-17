// Generates THIRD_PARTY_NOTICES.md from the packages actually bundled into dist/ (esbuild metafile + renderer deps),
// plus Electron (which ships Chromium/Node notices in its own LICENSES.chromium.html inside every build).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// Runtime code that ends up inside the application bundle.
const bundled = ['zod', 'd3-force', 'd3-dispatch', 'd3-quadtree', 'd3-timer', 'react', 'react-dom', 'scheduler'];
const shipped = ['electron'];

function info(name) {
  const dir = join(root, 'node_modules', name);
  const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licFile = readdirSync(dir).find((f) => /^(license|licence|copying)(\.|$)/i.test(f));
  return { name, version: p.version, license: p.license ?? p.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN', repo: typeof p.repository === 'string' ? p.repository : p.repository?.url, text: licFile ? readFileSync(join(dir, licFile), 'utf8').trim() : null };
}

const all = [...bundled, ...shipped].filter((n) => existsSync(join(root, 'node_modules', n))).map(info);
const allowed = /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|Unlicense)$/;
const bad = all.filter((d) => !allowed.test(d.license));
let md = `# Third-party notices\n\n${pkg.productName} ${pkg.version} is licensed under ${pkg.license}. It bundles the following third-party software.\n\n`;
md += '| Package | Version | License |\n|---|---|---|\n' + all.map((d) => `| ${d.name} | ${d.version} | ${d.license} |`).join('\n') + '\n\n';
md += 'Electron redistributes Chromium and Node.js; their notices are included in every build as `LICENSES.chromium.html`.\n\n';
for (const d of all) md += `## ${d.name} ${d.version}\n\n${d.repo ? `Source: ${d.repo}\n\n` : ''}\`\`\`\n${d.text ?? `License: ${d.license}`}\n\`\`\`\n\n`;
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), md);
console.log(`THIRD_PARTY_NOTICES.md: ${all.length} packages`);
if (bad.length) {
  console.error(`license review required: ${bad.map((d) => `${d.name} (${d.license})`).join(', ')}`);
  process.exit(1);
}
