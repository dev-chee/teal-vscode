import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { targets } from './toolchain-release.mjs';

/** 程序 API 不读取 VSCE_PAT；由入口显式传入，缺失时不得开始发布。 */
export async function publishDesktopPackages(publish, token, cwd = process.cwd()) {
    const pat = token?.trim();
    if (!pat) throw new Error('VSCE_PAT is required to publish desktop packages.');
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
    const packages = targets.map((target) => path.join(cwd, 'target', `${manifest.name}-${manifest.version}-${target}.vsix`));
    for (const file of packages) await access(file);
    await publish(packages, { pat, skipDuplicate: true });
}
