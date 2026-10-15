import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';
import { projectRoot, runNode } from './test-support.mjs';

runNode('scripts/test.mjs');
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Extension host tests require Windows x64; use test:unit or test:toolchain on WSL.');
}
if (!process.env.TEAL_TOOLCHAIN_PATH) throw new Error('TEAL_TOOLCHAIN_PATH must point at rebuilt Teal executables.');
runNode('scripts/build.mjs');

const profile = path.join(os.tmpdir(), `teal-vscode-user-${process.pid}`);
const workspace = path.join(profile, 'anchor.code-workspace');
mkdirSync(profile, { recursive: true });
writeFileSync(workspace, JSON.stringify({ folders: [{ path: '.' }] }));

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  extensionDevelopmentPath: process.env.TEAL_TEST_EXTENSION_PATH ?? projectRoot,
  extensionTestsPath: path.join(projectRoot, 'out-test', 'tests', 'extensionHost.test.js'),
  launchArgs: [
    '--disable-extensions',
    workspace,
    '--user-data-dir', profile,
    '--extensions-dir', path.join(os.tmpdir(), `teal-vscode-extensions-${process.pid}`),
  ],
});
