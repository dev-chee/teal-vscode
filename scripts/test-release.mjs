import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { distribution } from './toolchain-release.mjs';

const { values: { target } } = parseArgs({ options: { target: { type: 'string' } } });
if (!Object.hasOwn(distribution.targets, target) || !distribution.targets[target].extensionHost) {
    throw new Error(`Native extension host tests do not support target: ${target}`);
}
if (target !== `${process.platform}-${process.arch}`) {
    throw new Error(`Release target ${target} requires a matching native Runner; got ${process.platform}-${process.arch}.`);
}
if (!process.env.TEAL_TOOLCHAIN_PATH) throw new Error('TEAL_TOOLCHAIN_PATH is required for release validation.');

function run(script, args = [], env = {}, extensionHost = false) {
    const headless = extensionHost && process.platform === 'linux';
    const command = headless ? 'xvfb-run' : process.execPath;
    const parameters = headless ? ['--auto-servernum', process.execPath, script, ...args] : [script, ...args];
    const environment = { ...process.env, ...env };
    for (const key of Object.keys(environment)) if (environment[key] === undefined) delete environment[key];
    const result = spawnSync(command, parameters, { stdio: 'inherit', env: environment });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

run('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.json', '--noEmit']);
run('node_modules/eslint/bin/eslint.js', ['src', 'tests']);
run('scripts/test.mjs', ['--toolchain']);
// 与迁移前的 GitHub 门禁保持相同宿主用例范围。
run('scripts/test-electron.mjs', [], {
    TEAL_TEST_SUITE: undefined,
    TEAL_TEST_GREP: 'cold-starts|recognizes generated|debug configurations|resolves tier|serves concrete LSP|integrated-terminal|runs a Teal file|attaches to',
}, true);
for (const suite of ['toolchainUpdate.host.js', 'toolchainFolders.host.js', 'toolchainRecovery.host.js']) {
    run('scripts/test-electron.mjs', [], { TEAL_TEST_SUITE: suite, TEAL_TEST_GREP: undefined }, true);
}
