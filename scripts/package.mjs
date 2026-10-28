import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createVSIX } from '@vscode/vsce';
import { parseArgs } from 'node:util';
import * as path from 'node:path';
import { bundledToolchainPath, stageBundledToolchain } from './bundled-toolchain.mjs';
import { validateReleasePlan } from './gitlab-release-core.mjs';
import { stampBundledRelease } from './release-packages.mjs';

const distribution = JSON.parse(await readFile(new URL('../src/toolchain-targets.json', import.meta.url), 'utf8'));
const { values: { target, 'all-targets': allTargets, 'toolchain-path-file': toolchainPathFile, 'release-plan-file': releasePlanFile } } = parseArgs({ options: {
    target: { type: 'string' },
    'all-targets': { type: 'boolean' },
    'toolchain-path-file': { type: 'string' },
    'release-plan-file': { type: 'string' },
} });
if (target && allTargets) throw new Error('Use either --target or --all-targets.');
if (target !== undefined && !Object.hasOwn(distribution.targets, target)) throw new Error(`Unsupported target: ${target}`);
if (toolchainPathFile && (!target || allTargets)) throw new Error('A bundled toolchain requires exactly one --target.');
if (releasePlanFile && !toolchainPathFile) throw new Error('A release plan requires a bundled toolchain.');
const plan = releasePlanFile ? validateReleasePlan(JSON.parse(await readFile(releasePlanFile, 'utf8')), process.env.CI_COMMIT_SHA) : undefined;
const targets = allTargets ? Object.keys(distribution.targets) : [target];
const build = spawnSync(process.execPath, ['scripts/build.mjs', '--production'], { stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
await mkdir('target', { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (plan && manifest.version !== plan.extension.version) throw new Error('Apply the planned package version before packaging.');
const toolchain = toolchainPathFile ? await bundledToolchainPath(toolchainPathFile) : undefined;
for (const platform of targets) {
    const cleanup = toolchain ? await stageBundledToolchain(toolchain, platform) : undefined;
    try {
        if (plan) await stampBundledRelease(path.resolve('dist/toolchain'), plan, platform);
        await createVSIX({
            packagePath: `target/${manifest.name}-${manifest.version}${platform ? `-${platform}` : ''}.vsix`,
            target: platform,
            dependencies: false,
        });
    } finally {
        await cleanup?.();
    }
}
