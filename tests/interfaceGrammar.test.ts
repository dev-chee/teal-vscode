import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { isLocalTealDocument } from '../src/documents';
import { createGrammarRegistry, scopesAt } from './helpers/grammar';

const root = path.resolve(__dirname, '../..');

test('tli files have their own language and are excluded from source execution and LSP analysis', async () => {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const language = manifest.contributes.languages.find((entry: { extensions?: string[] }) => entry.extensions?.includes('.tli'));
    assert.ok(language, '.tli must be registered for builtin.tli and builtins.tli');
    assert.equal(language.id, 'teal-interface');
    assert.ok(manifest.contributes.grammars.some((entry: { language: string; scopeName: string }) => entry.language === language.id && entry.scopeName === 'source.teal.interface'));
    assert.equal(isLocalTealDocument({ languageId: language.id, uri: { scheme: 'file' }, isClosed: false }), false);
});

test('TextMate tokenizes builtin declarations, generics, task signatures and inherited comments', async () => {
    const registry = await createGrammarRegistry();
    try {
        const grammar = await registry.loadGrammar('source.teal.interface');
        assert.ok(grammar);
        const scopeAt = (line: string, word: string) => scopesAt(grammar, line, word);
        assert.ok(scopeAt('builtin trait Iterator<Item> {', 'builtin').includes('storage.modifier.teal'));
        assert.ok(scopeAt('builtin global {', 'global').includes('entity.name.namespace.teal'));
        assert.ok(scopeAt('builtin impl<T> Task<T> {', 'Task').includes('support.type.teal'));
        assert.ok(scopeAt('    task think<T>(prompt: string) -> T;', 'think').includes('entity.name.function.teal'));
        assert.ok(scopeAt('    fn checked_int(value: float) -> int | Error;', 'Error').includes('support.type.teal'));
        assert.ok(scopeAt('    fn print(values: printable...);', 'printable').includes('support.type.teal'));
        assert.ok(scopeAt('    @compile_time', '@compile_time').includes('entity.other.attribute-name.teal'));
        assert.ok(scopeAt('    @meta::CompileTime', 'CompileTime').includes('entity.other.attribute-name.teal'));
        assert.ok(scopeAt('/// builtin Task documentation', 'builtin').includes('comment.line.double-slash.teal'));
        assert.ok(scopeAt('"builtin Task"', 'builtin').includes('string.quoted.double.teal'));
    } finally { registry.dispose(); }
});
