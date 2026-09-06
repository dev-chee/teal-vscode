import { context } from 'esbuild';

const build = await context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
  minify: process.argv.includes('--production'),
  logLevel: 'info',
});
if (process.argv.includes('--watch')) {
  await build.watch();
} else {
  await build.rebuild();
  await build.dispose();
}
