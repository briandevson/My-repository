/**
 * Builds the single-player game as one self-contained HTML file.
 *
 * The whole game - world generation, the authoritative tick loop, combat,
 * skills - is bundled into the page and runs in the browser, so the file needs
 * no server and no network beyond the web font.
 */
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'dist', 'aetheria.html');

const bundle = await build({
  entryPoints: [join(root, 'client', 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  minify: true,
  write: false,
  define: { __AETHERIA_OFFLINE__: 'true' },
  legalComments: 'none',
});
const script = bundle.outputFiles[0].text;

// Reuse the served page's markup and styles so the two builds cannot drift.
const html = readFileSync(join(root, 'client', 'index.html'), 'utf8');
const css = readFileSync(join(root, 'client', 'style.css'), 'utf8');

const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

// The font is linked rather than @imported so it loads in parallel with the page.
const fontHref = css.match(/@import url\('([^']+)'\)/)?.[1] ?? '';
const styles = css.replace(/@import url\([^)]+\);\s*/, '');

// The artifact host owns <head>, so the page cannot ship a viewport meta tag.
// Mobile browsers otherwise lay the page out at 980px and the HUD renders
// desktop-sized on a phone. Inserting it from script works the same way.
const viewport = `<script>
(function () {
  var existing = document.querySelector('meta[name="viewport"]');
  var meta = existing || document.createElement('meta');
  meta.name = 'viewport';
  meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  if (!existing) document.head.appendChild(meta);
})();
<\/script>`;

const page = `<title>Aetheria</title>
${viewport}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="${fontHref}" />
<style>
${styles}
</style>
${body}
<script type="module">
${script}
</script>
`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, page);
const kb = (Buffer.byteLength(page) / 1024).toFixed(0);
console.log(`standalone build: ${out} (${kb} kB)`);
