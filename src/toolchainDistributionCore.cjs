/** 安装器与 CI 共用纯二进制分发校验；完成前不得发布安装状态或启动工具。 */
const { access, lstat, readFile, readdir, realpath } = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const distribution = require('./toolchain-targets.json');
const tools = ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt', 'teal-c', 'teal-test', 'teal-auth', 'teal-model', 'teal-audit'];

/** 解压前检查整个归档，连分发根目录外的源码和重复条目也不得放行。 */
function validateToolchainArchiveListing(listing) {
    const allowed = new Set([...tools, ...tools.map(tool => `${tool}.exe`), 'toolchain.json', 'manifest.json']);
    const seen = new Set();
    let root;
    for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
        const parts = entry.replace(/\/$/, '').split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
            throw new Error(`The Teal toolchain archive contains an unsafe path: ${entry}`);
        }
        root ??= parts[0];
        const name = parts.join('/');
        if (parts[0] !== root || seen.has(name)
            || (parts.length === 1 ? !entry.endsWith('/') : parts.length !== 2 || entry.endsWith('/') || !allowed.has(parts[1]))) {
            throw new Error(`Unexpected distribution archive entry: ${entry}`);
        }
        seen.add(name);
    }
    if (!seen.size) throw new Error('Empty distribution archive.');
}

async function verifyToolchainDistribution(directory, target) {
    if (!Object.hasOwn(distribution.targets, target)) throw new Error(`Unsupported target: ${target}`);
    const root = await realpath(directory);
    const windows = target.startsWith('win32-');
    for (const tool of ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt']) {
        const file = path.join(root, tool + (windows ? '.exe' : ''));
        const info = await lstat(file);
        if (!info.isFile() || !info.size) throw new Error(`Invalid tool: ${tool}`);
        if (!windows) await access(file, constants.X_OK);
    }
    const allowed = new Set(tools
        .map(tool => tool + (windows ? '.exe' : '')));
    allowed.add('toolchain.json');
    const manifestPath = path.join(root, 'manifest.json');
    if (!(await lstat(manifestPath)).isFile()) throw new Error('Missing distribution manifest.');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest?.formatVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
        throw new Error('Missing or invalid distribution manifest.');
    }
    const seen = new Set();
    for (const file of manifest.files) {
        // 分发只允许平铺的工具二进制和格式元数据；源码及外置 runtime 不进入安装目录。
        if (typeof file?.path !== 'string' || !allowed.has(file.path) || seen.has(file.path)) {
            throw new Error(`Invalid distribution path: ${file?.path}`);
        }
        seen.add(file.path);
        if (!Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256)) {
            throw new Error(`Invalid distribution metadata: ${file.path}`);
        }
        const resource = path.join(root, file.path);
        if (!(await lstat(resource)).isFile()) throw new Error(`Invalid distribution file: ${file.path}`);
        const content = await readFile(resource);
        if (content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256.toLowerCase()) {
            throw new Error(`Distribution digest mismatch: ${file.path}`);
        }
    }
    const actual = await readdir(root);
    if (actual.length !== seen.size + 1 || actual.some(name => name !== 'manifest.json' && !seen.has(name))) {
        throw new Error('Unexpected distribution files; only toolchain binaries and metadata are allowed.');
    }
    return root;
}

module.exports = { validateToolchainArchiveListing, verifyToolchainDistribution };
