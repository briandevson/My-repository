/**
 * Builds the single-player DEMO as one self-contained HTML file.
 *
 * The game itself is online only. This exists so the world can be shown to
 * someone without a server: an esbuild plugin swaps client/src/net.js for
 * tools/demo/net.js, which runs the authoritative GameWorld inside the page.
 * Nothing under client/ changes, and the served client never includes any of
 * it.
 */
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? join(root, 'dist', 'aetheria.html');

/** Redirect the client's socket transport to the in-page world. */
const demoTransport = {
  name: 'demo-transport',
  setup(builder) {
    builder.onResolve({ filter: /^\.\/net\.js$/ }, (args) => {
      if (!args.importer.includes(join('client', 'src'))) return null;
      return { path: resolve(root, 'tools', 'demo', 'net.js') };
    });
  },
};

const bundle = await build({
  entryPoints: [join(root, 'client', 'src', 'main.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari16'],
  minify: true,
  write: false,
  plugins: [demoTransport],
  legalComments: 'none',
});
const script = bundle.outputFiles[0].text;

// Reuse the real page's markup and styles so the demo cannot drift from the game.
const html = readFileSync(join(root, 'client', 'index.html'), 'utf8');
const css = readFileSync(join(root, 'client', 'style.css'), 'utf8');

const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'))
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

const fontHref = css.match(/@import url\('([^']+)'\)/)?.[1] ?? '';
const styles = css.replace(/@import url\([^)]+\);\s*/, '');

// The host owns <head>, so the page cannot ship a viewport meta tag; without
// one mobile browsers lay it out at 980px and the HUD renders desktop-sized.
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
console.log(`demo build: ${out} (${(Buffer.byteLength(page) / 1024).toFixed(0)} kB)`);
