/** 安装器与 CI 共用工具链和 runtime 校验；完成前不得发布安装状态或启动工具。 */
const { access, lstat, readFile, readdir, realpath } = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const distribution = require('./toolchain-targets.json');
const tools = ['teal', 'teal-lsp', 'teal-dap', 'teal-fmt', 'teal-c', 'teal-test', 'teal-auth', 'teal-model', 'teal-audit'];
const requiredRuntime = ['runtime/packages/catalog.toml', 'runtime/packages/std/package.toml', 'runtime/packages/std/builtins.tli'];

/** Teal 源码及运行资源可分发，Rust、构建输入和隐藏缓存不可分发。 */
function allowedRuntimeFile(name) {
    return name.startsWith('runtime/')
        && name.split('/').every(part => part && !part.startsWith('.') && !/[\\:\0]/.test(part)
            && !['target', 'node_modules', 'Cargo.toml', 'Cargo.lock'].includes(part))
        && ['.tl', '.tli', '.toml', '.json', '.md', '.txt', '.bin'].includes(path.posix.extname(name));
}

/** 嵌套资源需要在解压前拒绝链接和特殊文件，防止后续条目通过链接写出暂存目录。 */
function validateToolchainArchiveTypes(listing) {
    const entries = listing.split(/\r?\n/).filter(Boolean);
    if (!entries.length || entries.some(entry => entry[0] !== '-' && entry[0] !== 'd')) {
        throw new Error('The Teal toolchain archive contains a link or special file.');
    }
}

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
        const relative = parts.slice(1).join('/');
        const directory = entry.endsWith('/');
        const allowedEntry = parts.length === 1 ? directory : directory
            ? parts[1] === 'runtime' : allowed.has(relative) || allowedRuntimeFile(relative);
        if (parts[0] !== root || seen.has(name)
            || !allowedEntry) {
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
        // 同一清单保护工具和外置运行脚本，不允许借 runtime 路径附带宿主实现。
        if (typeof file?.path !== 'string' || (!allowed.has(file.path) && !allowedRuntimeFile(file.path)) || seen.has(file.path)) {
            throw new Error(`Invalid distribution path: ${file?.path}`);
        }
        seen.add(file.path);
        if (!Number.isSafeInteger(file.size) || file.size < 0 || (!file.size && allowed.has(file.path)) || typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256)) {
            throw new Error(`Invalid distribution metadata: ${file.path}`);
        }
        if (!(await lstat(path.join(root, file.path))).isFile()) throw new Error(`Invalid distribution file: ${file.path}`);
    }
    const actual = new Set();
    async function visit(directory, relative = '') {
        for (const name of await readdir(directory)) {
            const file = relative ? `${relative}/${name}` : name;
            const resource = path.join(directory, name);
            const info = await lstat(resource);
            if (info.isDirectory() && (file === 'runtime' || file.startsWith('runtime/'))
                && [...seen].some(candidate => candidate.startsWith(`${file}/`))) {
                await visit(resource, file);
            } else if (info.isFile() && (file === 'manifest.json' || seen.has(file))) {
                actual.add(file);
            } else {
                throw new Error(`Unexpected distribution file: ${file}`);
            }
        }
    }
    await visit(root);
    if (actual.size !== seen.size + 1 || [...seen].some(name => !actual.has(name))) {
        throw new Error('Missing distribution files.');
    }
    if (requiredRuntime.some(name => !seen.has(name))
        || ![...seen].some(name => name.startsWith('runtime/packages/') && name.endsWith('.tl'))) {
        throw new Error('Missing runtime resources or Teal sources.');
    }
    for (const file of manifest.files) {
        const resource = path.join(root, file.path);
        const content = await readFile(resource);
        if (content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256.toLowerCase()) {
            throw new Error(`Distribution digest mismatch: ${file.path}`);
        }
    }
    return root;
}

module.exports = { validateToolchainArchiveListing, validateToolchainArchiveTypes, verifyToolchainDistribution };
