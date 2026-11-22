import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // `vscode` is provided by the host. `playwright-core` is kept external on purpose: it
  // resolves helper assets (browsers.json, injected scripts) relative to its own install
  // directory, which inlining into a single file would break.
  external: ['vscode', 'playwright-core'],
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  // playwright-core ships optional native-ish require paths; keep the resolver quiet.
  logOverride: { 'require-resolve-not-external': 'silent' },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching src/extension.ts');
} else {
  await build(options);
  console.log('[esbuild] built dist/extension.js');
}
