import { build } from 'esbuild';

// The stub is compiled separately: the smoke test installs it as the `vscode` module at
// runtime, so it must not be bundled into the test file itself.
await build({
  entryPoints: ['test/vscode-stub.ts'],
  bundle: true,
  outfile: 'out/smoke-vscode-stub.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
});

await build({
  entryPoints: ['test/smoke.ts'],
  bundle: true,
  outfile: 'out/test-smoke.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['playwright-core'],
  logLevel: 'error',
});
console.log('[esbuild] built out/test-smoke.js');
