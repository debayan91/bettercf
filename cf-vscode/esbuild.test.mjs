import { build } from 'esbuild';

await build({
  entryPoints: [process.argv[2] ?? 'test/all.ts'],
  // jsdom/katex are Node-only test dependencies; keep them out of the bundle so their
  // dynamic requires (and katex's font assets) resolve normally at runtime.
  bundle: true,
  outfile: 'out/test-all.js', define: {},
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
  external: ['playwright-core', 'jsdom', 'katex'],
  alias: { vscode: './test/vscode-stub.ts' },
});
console.log('[esbuild] built out/test-all.js');
