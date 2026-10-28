import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { resolveBundledToolchain } from '../src/bundledToolchain';

async function distribution(root: string): Promise<string> {
    const directory = path.join(root, 'dist', 'toolchain');
    await mkdir(directory, { recursive: true });
    const executable = path.join(directory, 'teal');
    const formats = path.join(directory, 'toolchain.json');
    const runtime = path.join(directory, 'runtime', 'packages', 'std');
    await writeFile(executable, 'fixture executable');
    await chmod(executable, 0o755);
    await writeFile(formats, 'fixture formats');
    await mkdir(path.join(runtime, 'src'), { recursive: true });
    await writeFile(path.join(directory, 'runtime', 'packages', 'catalog.toml'), 'packages = ["std"]\n');
    await writeFile(path.join(runtime, 'package.toml'), 'modules = ["ui.tl"]\n');
    await writeFile(path.join(runtime, 'builtins.tli'), 'builtin global {}\n');
    await writeFile(path.join(runtime, 'src', 'ui.tl'), 'pub fn label() -> string { return "label"; }\n');
    const names = ['teal', 'toolchain.json', 'runtime/packages/catalog.toml', 'runtime/packages/std/package.toml', 'runtime/packages/std/builtins.tli', 'runtime/packages/std/src/ui.tl'];
    const files = await Promise.all(names.map(async name => {
        const content = await readFile(path.join(directory, name));
        return { path: name, size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    }));
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ formatVersion: 1, files,
        identity: { repository: 'dev-chee/teal-vscode', target: 'linux-x64', release: 'toolchain-v2.0.0' },
    }));
    return directory;
}

test('a target VSIX exposes its manifest-verified bundled toolchain', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-bundled-'));
    try {
        const directory = await distribution(root);
        assert.deepEqual(await resolveBundledToolchain(root, 'linux-x64'), { directory, release: 'toolchain-v2.0.0' });
        await writeFile(path.join(directory, 'teal'), 'tampered');
        assert.equal(await resolveBundledToolchain(root, 'linux-x64'), undefined);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('bundled toolchains require a stable release identity for the matching target and repository', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-bundled-identity-'));
    try {
        const directory = await distribution(root);
        const file = path.join(directory, 'manifest.json');
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        for (const identity of [undefined, null, {},
            { ...manifest.identity, release: 'latest' },
            { ...manifest.identity, release: 'toolchain-v2.0.0-beta' },
            { ...manifest.identity, target: 'darwin-arm64' },
            { ...manifest.identity, repository: 'other/repository' },
        ]) {
            await writeFile(file, JSON.stringify({ ...manifest, identity }));
            assert.equal(await resolveBundledToolchain(root, 'linux-x64'), undefined);
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('bundled GitLab builds retain their pipeline, job and source identity without claiming a public Release', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-vscode-bundled-gitlab-'));
    try {
        const directory = await distribution(root);
        const file = path.join(directory, 'manifest.json');
        const manifest = JSON.parse(await readFile(file, 'utf8'));
        const source = { kind: 'gitlab', pipelineId: 123, jobId: 456, sha: 'a'.repeat(40), archiveSha256: 'b'.repeat(64) };
        const identity = { repository: 'https://gitlab.example.com/group/teal', target: 'linux-x64', source,
            release: `gitlab-pipeline-123-${source.sha}` };
        await writeFile(file, JSON.stringify({ ...manifest, identity }));
        assert.deepEqual(await resolveBundledToolchain(root, 'linux-x64'), { directory, release: identity.release });
        for (const change of [{ release: 'toolchain-v2.0.0' }, { repository: 'http://gitlab.example.com/group/teal' },
            { source: { ...source, jobId: 0 } }, { source: { ...source, sha: 'latest' } }, { target: 'linux-arm64' }]) {
            await writeFile(file, JSON.stringify({ ...manifest, identity: { ...identity, ...change } }));
            assert.equal(await resolveBundledToolchain(root, 'linux-x64'), undefined);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});
