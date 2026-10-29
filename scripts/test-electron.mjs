import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { compileTests, hostExtensionPath, projectRoot, runNode } from './test-support.mjs';

// 聚焦宿主用例只编译入口，普通 pnpm test 仍保留完整单测阶段。
if (process.env.TEAL_TEST_SUITE) compileTests();
else runNode('scripts/test.mjs');
if (!['win32', 'linux', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Extension host tests require Windows, Linux or macOS x64/arm64.');
}
if (!process.env.TEAL_TOOLCHAIN_PATH) throw new Error('TEAL_TOOLCHAIN_PATH must point at rebuilt Teal executables.');
runNode('scripts/build.mjs');

const temporaryDirectory = realpathSync(os.tmpdir());
const profile = path.join(temporaryDirectory, `teal-vscode-user-${process.pid}`);
const workspace = path.join(profile, 'anchor.code-workspace');
mkdirSync(profile, { recursive: true });
writeFileSync(workspace, JSON.stringify({ folders: [{ path: '.' }] }));

const extensionDevelopmentPath = process.env.TEAL_TEST_EXTENSION_PATH ?? hostExtensionPath(process.env.TEAL_TEST_SUITE, profile);
let extensionTestsPath = path.join(projectRoot, 'out-test', 'tests', process.env.TEAL_TEST_SUITE ?? 'extensionHost.test.js');
if (!process.env.TEAL_TEST_EXTENSION_PATH && extensionDevelopmentPath !== projectRoot) {
  // vscode API 按调用模块归属扩展；将手动用例放入夹具扩展，保留调试器注册权限。
  const entry = extensionTestsPath;
  extensionTestsPath = path.join(extensionDevelopmentPath, 'host-test.cjs');
  await build({ entryPoints: [entry], outfile: extensionTestsPath, bundle: true,
    platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
}

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  cachePath: process.env.TEAL_VSCODE_TEST_CACHE,
  extensionDevelopmentPath,
  extensionTestsPath,
  extensionTestsEnv: { TEAL_TEST_STORAGE_DIR: path.join(profile, 'User', 'globalStorage', 'dev-chee.teal-vscode') },
  launchArgs: [
    '--disable-extensions',
    workspace,
    '--user-data-dir', profile,
    '--extensions-dir', path.join(temporaryDirectory, `teal-vscode-${process.pid}`),
  ],
});
