import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';
import { projectRoot, runNode } from './test-support.mjs';

runNode('scripts/test.mjs');
if (!['win32', 'linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Extension host tests require Windows, Linux or macOS x64/arm64.');
}
if (!process.env.TEAL_TOOLCHAIN_PATH) throw new Error('TEAL_TOOLCHAIN_PATH must point at rebuilt Teal executables.');
runNode('scripts/build.mjs');

const profile = path.join(os.tmpdir(), `teal-vscode-user-${process.pid}`);
const workspace = path.join(profile, 'anchor.code-workspace');
mkdirSync(profile, { recursive: true });
writeFileSync(workspace, JSON.stringify({ folders: [{ path: '.' }] }));

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  cachePath: process.env.TEAL_VSCODE_TEST_CACHE,
  extensionDevelopmentPath: process.env.TEAL_TEST_EXTENSION_PATH ?? projectRoot,
  extensionTestsPath: path.join(projectRoot, 'out-test', 'tests', process.env.TEAL_TEST_SUITE ?? 'extensionHost.test.js'),
  extensionTestsEnv: { TEAL_TEST_STORAGE_DIR: path.join(profile, 'User', 'globalStorage', 'dev-chee.teal-vscode') },
  launchArgs: [
    '--disable-extensions',
    workspace,
    '--user-data-dir', profile,
    '--extensions-dir', path.join(os.tmpdir(), `teal-vscode-extensions-${process.pid}`),
  ],
});
