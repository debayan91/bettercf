import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

// Renders the left-column webview document from a fixture statement so the typography and
// KaTeX delimiters can be reviewed in a normal browser without launching VS Code.
await build({
  entryPoints: ['test/preview.ts'],
  bundle: true,
  outfile: 'out/preview.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['playwright-core'],
  alias: { vscode: './test/vscode-stub.ts' },
  logLevel: 'error',
});

const { renderPreview } = require('./out/preview.js');
mkdirSync('docs', { recursive: true });
writeFileSync('docs/preview.html', renderPreview(), 'utf8');
console.log('[preview] wrote docs/preview.html');
