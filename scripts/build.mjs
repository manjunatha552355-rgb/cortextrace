// Bundles main + preload with esbuild and the renderer with Vite into dist/.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const dev = process.argv.includes('--dev');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: dev ? 'inline' : false, minify: !dev, logLevel: 'warning', legalComments: 'external' };
await build({ ...common, entryPoints: [join(root, 'src/main/main.ts')], outfile: join(dist, 'main.cjs') });
await build({ ...common, entryPoints: [join(root, 'src/main/preload.ts')], outfile: join(dist, 'preload.cjs') });

await viteBuild({
  root: join(root, 'src/renderer'),
  base: './',
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: join(dist, 'renderer'), emptyOutDir: true, sourcemap: dev, chunkSizeWarningLimit: 1500 },
});

for (const f of ['tray.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
  const src = join(root, 'build', f);
  if (existsSync(src)) cpSync(src, join(dist, f));
  else console.warn(`missing build/${f}; run: npx electron scripts/icons.cjs`);
}
console.log('build complete -> dist/');
