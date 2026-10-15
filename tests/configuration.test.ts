import assert from 'node:assert/strict';
import test from 'node:test';
import { runArguments, stringArray } from '../src/configuration';
import { isLocalTealDocument } from '../src/documents';

test('run arguments preserve spaces, unicode, flags and the program argument boundary', () => {
    assert.deepEqual(runArguments('/tmp/中文 program.tl', ['--tier', 'hosted'], ['a b', '--', '中文']),
        ['run', '--tier', 'hosted', '/tmp/中文 program.tl', '--', 'a b', '--', '中文']);
    assert.throws(() => runArguments('main.tl', ['--'], []), /must not contain/);
    assert.throws(() => runArguments('main.tl', [], [1]), /array of strings/);
    assert.throws(() => stringArray(null, 'config'), /array of strings/);
    const input = ['a'];
    const output = stringArray(input, 'config');
    input.push('b');
    assert.deepEqual(output, ['a']);
});

test('only open Teal file documents participate in execution and LSP grouping', () => {
    const doc = { uri: { scheme: 'file' }, languageId: 'teal', isClosed: false };
    assert.ok(isLocalTealDocument(doc));
    assert.ok(!isLocalTealDocument({ ...doc, uri: { scheme: 'git' } }));
    assert.ok(!isLocalTealDocument({ ...doc, uri: { scheme: 'untitled' } }));
    assert.ok(!isLocalTealDocument({ ...doc, languageId: 'plaintext' }));
    assert.ok(!isLocalTealDocument({ ...doc, isClosed: true }));
});
