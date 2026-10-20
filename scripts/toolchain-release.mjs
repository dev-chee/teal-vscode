import { readFileSync } from 'node:fs';

export const distribution = JSON.parse(readFileSync(new URL('../src/toolchain-targets.json', import.meta.url), 'utf8'));
export const targets = Object.keys(distribution.targets);
export function archiveName(target) {
    if (!Object.hasOwn(distribution.targets, target)) throw new Error(`Unsupported target: ${target}`);
    return `teal-${target}${target.startsWith('win32-') ? '.zip' : '.tar.gz'}`;
}

// 发布门禁要求同一正式 Release 包含全部目标；禁止混用不同版本的工具链。
export function selectRelease(releases, requiredTargets = targets) {
    return releases.find((release) => !release.draft && !release.prerelease && typeof release.tag_name === 'string'
        && Array.isArray(release.assets) && requiredTargets.every((target) => release.assets.some((asset) => asset.name === archiveName(target))));
}

export async function readRelease(tag = 'latest') {
    const base = `https://api.github.com/repos/${distribution.repository}/releases`;
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'teal-vscode' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    if (tag !== 'latest') {
        const response = await fetch(`${base}/tags/${encodeURIComponent(tag)}`, { headers });
        if (!response.ok) throw new Error(`Toolchain Release ${tag}: HTTP ${response.status}`);
        const release = await response.json();
        if (!selectRelease([release])) throw new Error(`Release ${tag} must contain all ${targets.length} desktop archives and must not be a draft or prerelease.`);
        return release;
    }
    for (let page = 1; page <= 10; page++) {
        const response = await fetch(`${base}?per_page=100&page=${page}`, { headers });
        if (!response.ok) throw new Error(`Toolchain Releases: HTTP ${response.status}`);
        const releases = await response.json();
        if (!Array.isArray(releases)) throw new Error('Invalid toolchain release list.');
        const release = selectRelease(releases);
        if (release) return release;
        if (releases.length < 100) break;
    }
    throw new Error(`No stable Release in ${distribution.repository} contains all ${targets.length} desktop archives.`);
}
