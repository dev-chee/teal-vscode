import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { targets } from './toolchain-release.mjs';
import { verifyReleasePackages } from './release-packages.mjs';

/** Marketplace 仅接受与当前检出插件版本完全一致的标签。 */
export function validateMarketplaceTag(tag, version) {
    if (!version || tag !== `v${version}`) {
        throw new Error('Publishing requires a v* tag matching package.json version.');
    }
}

/** 程序 API 不读取 VSCE_PAT；由入口显式传入，缺失时不得开始发布。 */
export async function publishDesktopPackages(publish, token, cwd = process.cwd(), releasePlan) {
    const pat = token?.trim();
    if (!pat) throw new Error('VSCE_PAT is required to publish desktop packages.');
    const manifest = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8'));
    const packages = releasePlan ? await verifyReleasePackages(releasePlan, cwd)
        : targets.map((target) => path.join(cwd, 'target', `${manifest.name}-${manifest.version}-${target}.vsix`));
    for (const file of packages) await access(file);
    await publish(packages, { pat, skipDuplicate: true });
}
