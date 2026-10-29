/** 安装器与 CI 共用工具链和 runtime 校验；完成前不得发布安装状态或启动工具。 */
const { access, lstat, readFile, readdir, realpath } = require('node:fs/promises');
const { constants } = require('node:fs');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const distribution = require('./toolchain-targets.json');
// 发行版只携带一个 teal 可执行文件；LSP、DAP 和格式化由它的子命令提供。
const tools = ['teal'];
const requiredRuntime = ['runtime/packages/catalog.toml', 'runtime/packages/std/package.toml', 'runtime/packages/std/builtins.tli'];
const validationConcurrency = 16;
const hashingConcurrency = 8;

async function mapLimit(values, limit, action) {
    const output = new Array(values.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
        for (;;) {
            const index = next++;
            if (index >= values.length) return;
            output[index] = await action(values[index]);
        }
    }));
    return output;
}

async function hashFile(file) {
    const hash = createHash('sha256');
    let size = 0;
    await new Promise((resolve, reject) => {
        const stream = createReadStream(file);
        stream.on('data', chunk => { size += chunk.length; hash.update(chunk); });
        stream.once('error', reject);
        stream.once('end', resolve);
    });
    return { size, sha256: hash.digest('hex') };
}

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
    const entries = listing.split(/\r?\n/).filter(Boolean);
    // Rust tar 的目录名不带末尾 /；从子条目收集父目录，不依赖归档条目顺序。
    const directories = new Set();
    for (const entry of entries) {
        const parts = entry.split('/');
        for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
    }
    const seen = new Set();
    let root;
    for (const entry of entries) {
        const parts = entry.replace(/\/$/, '').split('/');
        if (parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part))) {
            throw new Error(`The Teal toolchain archive contains an unsafe path: ${entry}`);
        }
        root ??= parts[0];
        const name = parts.join('/');
        const relative = parts.slice(1).join('/');
        const directory = entry.endsWith('/') || directories.has(name);
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
    for (const tool of tools) {
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
    const directories = new Set();
    for (const file of manifest.files) {
        // 同一清单保护工具和外置运行脚本，不允许借 runtime 路径附带宿主实现。
        if (typeof file?.path !== 'string' || (!allowed.has(file.path) && !allowedRuntimeFile(file.path)) || seen.has(file.path)) {
            throw new Error(`Invalid distribution path: ${file?.path}`);
        }
        seen.add(file.path);
        if (!Number.isSafeInteger(file.size) || file.size < 0 || (!file.size && allowed.has(file.path)) || typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256)) {
            throw new Error(`Invalid distribution metadata: ${file.path}`);
        }
        const parts = file.path.split('/');
        for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
    }
    await mapLimit(manifest.files, validationConcurrency, async file => {
        if (!(await lstat(path.join(root, file.path))).isFile()) throw new Error(`Invalid distribution file: ${file.path}`);
    });
    const actual = new Set();
    async function visit(directory, relative = '') {
        for (const name of await readdir(directory)) {
            const file = relative ? `${relative}/${name}` : name;
            const resource = path.join(directory, name);
            const info = await lstat(resource);
            if (info.isDirectory() && directories.has(file)) {
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
    await mapLimit(manifest.files, hashingConcurrency, async file => {
        const resource = path.join(root, file.path);
        const content = await hashFile(resource);
        if (content.size !== file.size || content.sha256 !== file.sha256.toLowerCase()) {
            throw new Error(`Distribution digest mismatch: ${file.path}`);
        }
    });
    return root;
}

/** CI 校验后记录正式 Release 或固定 GitLab 构建；包内回退不得猜测来源或跨目标使用。 */
async function readToolchainIdentity(directory, target) {
    const { identity } = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const source = identity?.source;
    let gitlab = false;
    if (source?.kind === 'gitlab') {
        let repository;
        try { repository = new globalThis.URL(identity.repository); } catch { /* 下方统一拒绝不完整来源。 */ }
        gitlab = repository?.protocol === 'https:' && !repository.username && !repository.password
            && !repository.search && !repository.hash && /^\/(?:[\w.-]+\/)+[\w.-]+$/.test(repository.pathname)
            && Number.isSafeInteger(source.pipelineId) && source.pipelineId > 0
            && Number.isSafeInteger(source.jobId) && source.jobId > 0
            && /^[a-f0-9]{40}$/.test(source.sha) && /^[a-f0-9]{64}$/.test(source.archiveSha256)
            && identity.release === `gitlab-pipeline-${source.pipelineId}-${source.sha}`;
    }
    const published = !source && identity?.repository === distribution.repository
        && typeof identity.release === 'string' && /^toolchain-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(identity.release);
    if (identity?.target !== target || !published && !gitlab) {
        throw new Error('Missing or invalid toolchain release identity.');
    }
    return { repository: String(identity.repository), target: String(identity.target), release: String(identity.release) };
}

module.exports = { validateToolchainArchiveListing, validateToolchainArchiveTypes, verifyToolchainDistribution, readToolchainIdentity };
