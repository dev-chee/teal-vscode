import { access, readFile } from 'node:fs/promises';
import { publishVSIX } from '@vscode/vsce';
import { targets } from './toolchain-release.mjs';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const packages = targets.map((target) => `target/${manifest.name}-${manifest.version}-${target}.vsix`);
for (const file of packages) await access(file);
await publishVSIX(packages, { skipDuplicate: true });
