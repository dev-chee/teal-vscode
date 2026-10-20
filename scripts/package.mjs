import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createVSIX } from '@vscode/vsce';
import { parseArgs } from 'node:util';

const distribution = JSON.parse(await readFile(new URL('../src/toolchain-targets.json', import.meta.url), 'utf8'));
const { values: { target, 'all-targets': allTargets } } = parseArgs({ options: { target: { type: 'string' }, 'all-targets': { type: 'boolean' } } });
if (target && allTargets) throw new Error('Use either --target or --all-targets.');
if (target !== undefined && !Object.hasOwn(distribution.targets, target)) throw new Error(`Unsupported target: ${target}`);
const targets = allTargets ? Object.keys(distribution.targets) : [target];
const build = spawnSync(process.execPath, ['scripts/build.mjs', '--production'], { stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
await mkdir('target', { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
for (const platform of targets) {
    await createVSIX({
        packagePath: `target/${manifest.name}-${manifest.version}${platform ? `-${platform}` : ''}.vsix`,
        target: platform,
        dependencies: false,
    });
}
