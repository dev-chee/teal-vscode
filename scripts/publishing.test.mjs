import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { targets } from './toolchain-release.mjs';
import { publishDesktopPackages } from './publishing.mjs';

test('publishing authenticates every prebuilt desktop target and fails before side effects without a PAT', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-publish-'));
    const calls = [];
    const publish = async (...args) => { calls.push(args); };
    try {
        for (const token of [undefined, '', '  ']) await assert.rejects(publishDesktopPackages(publish, token, root), /VSCE_PAT is required/);
        assert.equal(calls.length, 0);
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'teal-vscode', version: '1.2.3' }));
        await mkdir(path.join(root, 'target'));
        const files = targets.map(target => path.join(root, 'target', `teal-vscode-1.2.3-${target}.vsix`));
        for (const file of files.slice(1)) await writeFile(file, 'fixture');
        await assert.rejects(publishDesktopPackages(publish, 'synthetic-token', root), /ENOENT/);
        assert.equal(calls.length, 0, 'partial input sets must not publish any platform');
        await writeFile(files[0], 'fixture');
        await publishDesktopPackages(publish, 'synthetic-token', root);
        assert.deepEqual(calls, [[files, { pat: 'synthetic-token', skipDuplicate: true }]]);
    } finally { await rm(root, { recursive: true, force: true }); }
});
