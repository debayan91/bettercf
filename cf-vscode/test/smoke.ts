/**
 * Activation smoke test: requires the *real* esbuild output (dist/extension.js) with `vscode`
 * redirected to the stub, then activates and deactivates it exactly like the host would. This
 * catches runtime-only mistakes (top-level throws, bad imports, wrong command ids) that a
 * type-check and a unit test would both miss.
 */
import * as assert from 'node:assert';
import * as nodeModule from 'node:module';
import * as path from 'node:path';

// `require('module')` returns the live CommonJS Module object, which (unlike the ESM namespace)
// allows monkey-patching `_load`. This is how `vscode` is redirected to the stub at runtime.
interface ModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

const loader = require('module') as ModuleLoader;
const originalLoad = loader._load;
loader._load = function patched(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') {
    return require(path.join(__dirname, 'smoke-vscode-stub.js'));
  }
  return originalLoad.call(this, request, parent, isMain);
};
void nodeModule;

interface ExtensionModule {
  activate(context: unknown): Promise<void> | void;
  deactivate(): Promise<void> | void;
}

async function main(): Promise<void> {
  const extensionPath = path.join(__dirname, '..', 'dist', 'extension.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const extension = require(extensionPath) as ExtensionModule;
  assert.equal(typeof extension.activate, 'function', 'activate must be exported');
  assert.equal(typeof extension.deactivate, 'function', 'deactivate must be exported');

  const context = {
    subscriptions: [] as Array<{ dispose(): void }>,
    extensionUri: { fsPath: path.join(__dirname, '..'), scheme: 'file' },
    globalStorageUri: { fsPath: path.join(process.cwd(), 'out', 'smoke-storage'), scheme: 'file' },
  };

  await extension.activate(context);
  const registered = (globalThis as Record<string, unknown>).__registeredCommands as string[] | undefined;
  assert.ok(Array.isArray(registered), 'commands were not registered');
  const expected = [
    'cfVscode.login',
    'cfVscode.refreshSession',
    'cfVscode.loadContest',
    'cfVscode.openProblem',
    'cfVscode.switchProblem',
    'cfVscode.runTests',
    'cfVscode.submit',
  ];
  for (const command of expected) {
    assert.ok(registered?.includes(command), `${command} was not registered`);
  }
  assert.ok(context.subscriptions.length > 0, 'disposables were not registered on the context');

  await extension.deactivate();
  console.log(`  ok   activates, registers ${expected.length} commands and deactivates cleanly`);
}

main().catch((error) => {
  console.error('  FAIL activation smoke test');
  console.error(`       ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
