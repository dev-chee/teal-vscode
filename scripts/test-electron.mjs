import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';

const tsc = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const build = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const compile = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
if (compile.status !== 0) process.exit(compile.status ?? 1);

const unit = 'out-test/tests/toolchain.test.js';
if (!existsSync(unit)) throw new Error(`missing compiled unit test ${unit}`);
const result = spawnSync(process.execPath, ['--test', unit], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);

const profile = path.join(os.tmpdir(), `teal-vscode-user-${process.pid}`);
const workspace = path.join(profile, 'anchor.code-workspace');
mkdirSync(profile, { recursive: true });
writeFileSync(workspace, JSON.stringify({ folders: [{ path: '.' }] }));

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  extensionDevelopmentPath: process.env.TEAL_TEST_EXTENSION_PATH ?? process.cwd(),
  extensionTestsPath: path.join(process.cwd(), 'out-test', 'tests', 'extensionHost.test.js'),
  launchArgs: [
    '--disable-extensions',
    workspace,
    '--user-data-dir', profile,
    '--extensions-dir', path.join(os.tmpdir(), `teal-vscode-extensions-${process.pid}`),
  ],
});
