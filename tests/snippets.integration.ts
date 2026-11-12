import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { executableName } from '../src/platform';

test('module import and entry point snippets compile together', async () => {
    const toolchain = process.env.TEAL_TOOLCHAIN_PATH;
    assert.ok(toolchain, 'TEAL_TOOLCHAIN_PATH must point at rebuilt Teal executables');
    const snippets: Record<string, { prefix: string; body: string[] }> = JSON.parse(await readFile(path.join(__dirname, '../../snippets/teal.json'), 'utf8'));
    const definitions = Object.values(snippets);
    const imports = definitions.filter(snippet => snippet.prefix === 'use');
    assert.equal(imports.length, 1, 'offer the current use keyword');
    assert.ok(!definitions.some(snippet => snippet.prefix === 'import'), 'do not offer the removed keyword');
    const host = definitions.find(snippet => snippet.prefix === 'host');
    assert.ok(host, 'offer a host module import snippet');
    const expanded = [...imports[0].body, ...host.body].join('\n').replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
    for (const prefix of ['main', 'taskmain']) {
        const entry = definitions.find(snippet => snippet.prefix === prefix);
        assert.ok(entry, `offer a ${prefix} snippet`);
        const source = `${expanded}\n${entry.body.join('\n').replace('$0', 'print(json::has("[]", ""));')}\n`;
        const result: SpawnSyncReturns<string> = spawnSync(path.join(toolchain, executableName('teal')), ['compile', '--tier', 'hosted', '--code', source], { encoding: 'utf8', timeout: 20_000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
    }
});
