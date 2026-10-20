/** 扩展安装器与 CI 共用正式、完整发行版的选择和分页读取规则。 */
function createReleasePolicy(distribution) {
    const targets = Object.keys(distribution.targets);
    const base = `https://api.github.com/repos/${distribution.repository}/releases`;
    function archiveName(target) {
        if (!Object.hasOwn(distribution.targets, target)) throw new Error(`Unsupported target: ${target}`);
        return `teal-${target}${target.startsWith('win32-') ? '.zip' : '.tar.gz'}`;
    }
    function selectRelease(releases) {
        return releases.find(release => release && typeof release === 'object' && !release.draft && !release.prerelease && typeof release.tag_name === 'string'
            && Array.isArray(release.assets) && targets.every(target => release.assets.some(asset => asset && asset.name === archiveName(target))));
    }
    function apiUrl(value, page = 1) {
        const tag = value.trim() || 'latest';
        return tag.toLowerCase() === 'latest' ? `${base}?per_page=100&page=${page}` : `${base}/tags/${encodeURIComponent(tag)}`;
    }
    async function readRelease(value = 'latest', token, fetcher = globalThis.fetch) {
        const tag = value.trim() || 'latest';
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'teal-vscode' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const latest = tag.toLowerCase() === 'latest';
        for (let page = 1; page <= (latest ? 10 : 1); page++) {
            const url = apiUrl(tag, page);
            const response = await fetcher(url, { headers });
            if (!response.ok) throw new Error(`Toolchain Release ${tag}: HTTP ${response.status}`);
            const data = await response.json();
            if (latest && !Array.isArray(data)) throw new Error('Invalid toolchain release list.');
            const releases = latest ? data : [data];
            const release = selectRelease(releases);
            if (release) return release;
            if (!latest || releases.length < 100) break;
        }
        throw new Error(`No stable Release for ${tag} in ${distribution.repository} contains all ${targets.length} desktop archives.`);
    }
    return { targets, archiveName, selectRelease, readRelease, apiUrl };
}
module.exports = { createReleasePolicy };
