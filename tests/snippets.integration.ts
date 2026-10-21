import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { executableName } from '../src/platform';

test('module import snippet compiles with the current logical module syntax', async () => {
    const toolchain = process.env.TEAL_TOOLCHAIN_PATH;
    assert.ok(toolchain, 'TEAL_TOOLCHAIN_PATH must point at rebuilt Teal executables');
    const snippets: Record<string, { prefix: string; body: string[] }> = JSON.parse(await readFile(path.join(__dirname, '../../snippets/teal.json'), 'utf8'));
    const imports = Object.values(snippets).filter(snippet => snippet.prefix === 'use');
    assert.equal(imports.length, 1, 'offer the current use keyword');
    assert.ok(!Object.values(snippets).some(snippet => snippet.prefix === 'import'), 'do not offer the removed keyword');
    const expanded = imports[0].body.join('\n').replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
    const source = `${expanded}\nfn main() { print(json::has("[]", "")); }\n`;
    const result = spawnSync(path.join(toolchain, executableName('teal')), ['compile', '--tier', 'hosted', '--code', source], { encoding: 'utf8', timeout: 20_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
});
