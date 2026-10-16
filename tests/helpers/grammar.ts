import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { INITIAL, Registry, parseRawGrammar, type IGrammar } from 'vscode-textmate';
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma';

const root = path.resolve(__dirname, '../../..');

export async function createGrammarRegistry(): Promise<Registry> {
    await loadWASM(await readFile(require.resolve('vscode-oniguruma/release/onig.wasm')));
    const files = new Map([
        ['source.teal', 'teal.tmLanguage.json'],
        ['source.teal.interface', 'teal-interface.tmLanguage.json'],
    ]);
    return new Registry({
        onigLib: Promise.resolve({ createOnigScanner: (patterns) => new OnigScanner(patterns), createOnigString: (value) => new OnigString(value) }),
        loadGrammar: async (scope) => {
            const file = files.get(scope);
            if (!file) return null;
            const filename = path.join(root, 'syntaxes', file);
            return parseRawGrammar(await readFile(filename, 'utf8'), filename);
        },
    });
}

export function scopesAt(grammar: IGrammar, source: string, word: string): string[] {
    const offset = source.indexOf(word);
    assert.ok(offset >= 0, `Missing ${word} in test source`);
    let lineStart = 0;
    let stack = INITIAL;
    for (const line of source.split('\n')) {
        const result = grammar.tokenizeLine(line, stack);
        if (offset < lineStart + line.length) {
            const token = result.tokens.find((item) => item.startIndex <= offset - lineStart && item.endIndex > offset - lineStart);
            assert.ok(token);
            return token.scopes;
        }
        lineStart += line.length + 1;
        stack = result.ruleStack;
    }
    assert.fail(`No token for ${word}`);
}
