import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { INITIAL, Registry, parseRawGrammar } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';
import { isLocalTealDocument } from '../src/documents';

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
    await loadWASM(await readFile(require.resolve('vscode-oniguruma/release/onig.wasm')));
    const files = new Map([
        ['source.teal', 'teal.tmLanguage.json'],
        ['source.teal.interface', 'teal-interface.tmLanguage.json'],
    ]);
    const registry = new Registry({
        onigLib: Promise.resolve({ createOnigScanner: (patterns) => new OnigScanner(patterns), createOnigString: (value) => new OnigString(value) }),
        loadGrammar: async (scope) => {
            const file = files.get(scope);
            if (!file) return null;
            const filename = path.join(root, 'syntaxes', file);
            return parseRawGrammar(await readFile(filename, 'utf8'), filename);
        },
    });
    try {
        const grammar = await registry.loadGrammar('source.teal.interface');
        assert.ok(grammar);
        const scopeAt = (line: string, word: string) => {
            const offset = line.indexOf(word);
            assert.ok(offset >= 0);
            const token = grammar.tokenizeLine(line, INITIAL).tokens.find((item) => item.startIndex <= offset && item.endIndex > offset);
            assert.ok(token);
            return token.scopes;
        };
        assert.ok(scopeAt('builtin trait Iterator<Item> {', 'builtin').includes('storage.modifier.teal'));
        assert.ok(scopeAt('builtin global {', 'global').includes('entity.name.namespace.teal'));
        assert.ok(scopeAt('builtin impl<T> Task<T> {', 'Task').includes('support.type.teal'));
        assert.ok(scopeAt('    task think<T>(prompt: string) -> T;', 'think').includes('entity.name.function.teal'));
        assert.ok(scopeAt('    fn checked_int(value: float) -> int | Error;', 'Error').includes('support.type.teal'));
        assert.ok(scopeAt('    fn print(values: printable...);', 'printable').includes('support.type.teal'));
        assert.ok(scopeAt('    @compile_time', '@compile_time').includes('entity.other.attribute-name.teal'));
        assert.ok(scopeAt('/// builtin Task documentation', 'builtin').includes('comment.line.double-slash.teal'));
        assert.ok(scopeAt('"builtin Task"', 'builtin').includes('string.quoted.double.teal'));
    } finally { registry.dispose(); }
});
