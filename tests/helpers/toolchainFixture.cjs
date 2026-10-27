const { createHash } = require('node:crypto');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const runtimeResources = {
    'runtime/packages/catalog.toml': 'packages = ["std"]\n',
    'runtime/packages/std/package.toml': 'modules = ["ui.tl"]\n',
    'runtime/packages/std/builtins.tli': 'builtin global {}\n',
    'runtime/packages/std/src/ui.tl': 'pub fn label() -> string { return "label"; }\n',
};

/** 将当前分发契约必需的 runtime 资源及其摘要加入夹具清单。 */
async function writeRuntimeFixture(bundle, files, additions = {}) {
    for (const [file, source] of Object.entries({ ...runtimeResources, ...additions })) {
        await mkdir(path.dirname(path.join(bundle, file)), { recursive: true });
        await writeFile(path.join(bundle, file), source);
        const bytes = globalThis.Buffer.from(source);
        files.push({ path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
}

module.exports = { runtimeResources, writeRuntimeFixture };
