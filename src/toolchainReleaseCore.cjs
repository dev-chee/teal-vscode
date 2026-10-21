/** 正式工具链版本独立于插件版本；数值比较避免发布顺序造成回退。 */
function compareToolchainVersions(left, right) {
    const parse = value => /^toolchain-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
    const a = parse(left), b = parse(right);
    if (!a || !b) return undefined;
    for (let i = 1; i <= 3; i++) {
        const x = BigInt(a[i]), y = BigInt(b[i]);
        if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
}

/** 扩展安装器与 CI 共用正式、完整发行版的选择和分页读取规则。 */
function createReleasePolicy(distribution) {
    const targets = Object.keys(distribution.targets);
    const base = `https://api.github.com/repos/${distribution.repository}/releases`;
    function archiveName(target) {
        if (!Object.hasOwn(distribution.targets, target)) throw new Error(`Unsupported target: ${target}`);
        return `teal-${target}${target.startsWith('win32-') ? '.zip' : '.tar.gz'}`;
    }
    function complete(release) {
        return release && typeof release === 'object' && !release.draft && !release.prerelease && typeof release.tag_name === 'string'
            && Array.isArray(release.assets) && targets.every(target => release.assets.some(asset => asset && asset.name === archiveName(target)));
    }
    function selectRelease(releases) {
        return releases.filter(release => complete(release) && compareToolchainVersions(release.tag_name, release.tag_name) === 0)
            .reduce((best, release) => !best || compareToolchainVersions(release.tag_name, best.tag_name) > 0 ? release : best, undefined);
    }
    function apiUrl(value, page = 1) {
        const tag = value.trim() || 'latest';
        return tag.toLowerCase() === 'latest' ? `${base}?per_page=100&page=${page}` : `${base}/tags/${encodeURIComponent(tag)}`;
    }
    async function readRelease(value = 'latest', token, fetcher = globalThis.fetch, signal) {
        const tag = value.trim() || 'latest';
        const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'teal-vscode' };
        if (token) headers.Authorization = `Bearer ${token}`;
        const latest = tag.toLowerCase() === 'latest';
        let best;
        // 整次元数据请求共用 15 秒期限，包括分页和响应正文。
        const timeout = globalThis.AbortSignal.timeout(15_000);
        const requestSignal = signal ? globalThis.AbortSignal.any([signal, timeout]) : timeout;
        for (let page = 1; page <= (latest ? 10 : 1); page++) {
            const url = apiUrl(tag, page);
            const response = await fetcher(url, { headers, signal: requestSignal });
            if (!response.ok) throw new Error(`Toolchain Release ${tag}: HTTP ${response.status}`);
            const data = await response.json();
            if (latest && !Array.isArray(data)) throw new Error('Invalid toolchain release list.');
            const releases = latest ? data : [data];
            const release = latest ? selectRelease(releases) : (complete(data) && data.tag_name === tag ? data : undefined);
            if (release && (!best || !latest || compareToolchainVersions(release.tag_name, best.tag_name) > 0)) best = release;
            if (!latest || releases.length < 100) {
                if (best) return best;
                break;
            }
            if (page === 10) throw new Error('Toolchain release pagination exceeded 1000 releases; refusing an uncertain latest version.');
        }
        throw new Error(`No stable Release for ${tag} in ${distribution.repository} contains all ${targets.length} desktop archives.`);
    }
    return { targets, archiveName, selectRelease, readRelease, apiUrl };
}
module.exports = { createReleasePolicy, compareToolchainVersions };
