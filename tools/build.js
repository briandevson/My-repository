import { build, context } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const options = {
  entryPoints: [join(root, 'client', 'src', 'main.js')],
  outfile: join(root, 'client', 'dist', 'bundle.js'),
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  sourcemap: true,
  define: { __AETHERIA_OFFLINE__: 'false' },
  minify: process.argv.includes('--minify'),
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('esbuild: watching client sources...');
} else {
  await build(options);
}
