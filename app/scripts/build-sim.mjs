// Bundles sim/main.ts into a single self-contained HTML page: sim/dist/openbee-display-sim.html
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  entryPoints: [join(root, 'sim/main.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(join(root, 'sim/template.html'), 'utf8').replace('/*BUNDLE*/', () => js);
mkdirSync(join(root, 'sim/dist'), { recursive: true });
const out = join(root, 'sim/dist/openbee-display-sim.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(1)} KB)`);
