import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createVSIX } from '@vscode/vsce';

const build = spawnSync(process.execPath, ['scripts/build.mjs', '--production'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
await mkdir('target', { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
await createVSIX({
    packagePath: `target/${manifest.name}-${manifest.version}.vsix`,
    dependencies: false,
    allowMissingRepository: true,
});
