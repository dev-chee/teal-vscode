/** 安装器与 CI 共用分发校验；完成前不得发布安装状态或启动工具。 */
const { access, lstat, readFile, realpath } = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const distribution = require('./toolchain-targets.json');

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
    const runtime = path.join(root, 'runtime');
    if (!(await lstat(runtime)).isDirectory()) throw new Error('Missing runtime directory.');
    const manifestPath = path.join(runtime, 'manifest.json');
    if (!(await lstat(manifestPath)).isFile()) throw new Error('Missing runtime manifest.');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest?.formatVersion !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) {
        throw new Error('Missing or invalid runtime manifest.');
    }
    const seen = new Set();
    for (const file of manifest.files) {
        // 分发清单使用 POSIX 相对路径；拒绝平台歧义和链接，移动目录后仍须可用。
        const parts = typeof file?.path === 'string' ? file.path.split('/') : [];
        if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part) || part.includes('\0'))
            || seen.has(file.path) || file.path === 'manifest.json') {
            throw new Error(`Invalid runtime path: ${file?.path}`);
        }
        seen.add(file.path);
        if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(file.sha256)) {
            throw new Error(`Invalid runtime metadata: ${file.path}`);
        }
        let resource = runtime;
        for (let index = 0; index < parts.length; index++) {
            resource = path.join(resource, parts[index]);
            const info = await lstat(resource);
            if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
                throw new Error(`Invalid runtime resource: ${file.path}`);
            }
        }
        const content = await readFile(resource);
        if (content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256.toLowerCase()) {
            throw new Error(`Runtime digest mismatch: ${file.path}`);
        }
    }
    return root;
}

module.exports = { verifyToolchainDistribution };
