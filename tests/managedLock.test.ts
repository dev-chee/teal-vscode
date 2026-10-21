import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { withManagedLock } from '../src/managedLock';

test('separate extension-host processes serialize transactions in shared storage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-process-lock-'));
    try {
        const counter = path.join(root, 'counter');
        await writeFile(counter, '0');
        const script = `
            const {withManagedLock} = require(${JSON.stringify(require.resolve('../src/managedLock'))});
            const fs = require('node:fs/promises');
            withManagedLock(process.argv[1], async () => {
                const file = process.argv[1] + '/counter';
                const before = Number(await fs.readFile(file, 'utf8'));
                await new Promise(resolve => setTimeout(resolve, 100));
                await fs.writeFile(file, String(before + 1));
            }).catch(error => { console.error(error); process.exitCode = 1; });
        `;
        await Promise.all(Array.from({ length: 3 }, () => new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, ['-e', script, root], { stdio: ['ignore', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr.on('data', data => { stderr += String(data); });
            child.once('error', reject);
            child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
        })));
        assert.equal(await readFile(counter, 'utf8'), '3');
        const controller = new AbortController(); controller.abort();
        await assert.rejects(withManagedLock(root, async () => assert.fail('cancelled transaction ran'), controller.signal), { name: 'AbortError' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
