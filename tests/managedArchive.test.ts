import assert from 'node:assert/strict';
import test from 'node:test';
import { validateArchiveListing } from '../src/toolchainDownloadCore';

test('managed archives reject traversal and absolute paths', () => {
    assert.doesNotThrow(() => validateArchiveListing('teal-0.1.0/\nteal-0.1.0/teal\nteal-0.1.0/manifest.json'));
    assert.throws(() => validateArchiveListing('../outside/teal'), /unsafe path/);
    assert.throws(() => validateArchiveListing('/absolute/teal'), /unsafe path/);
    assert.throws(() => validateArchiveListing('C:\\outside\\teal'), /unsafe path/);
});

test('managed archives contain a single toolchain with runtime Teal sources', () => {
    assert.doesNotThrow(() => validateArchiveListing('bundle/teal\nbundle/runtime/\nbundle/runtime/packages/std/src/ui.tl'));
    for (const extra of ['bundle/compiler.rs', 'bundle/std.tl', 'bundle/runtime/compiler.rs', 'source/compiler.rs', 'source.rs', 'bundle/teal/']) {
        assert.throws(() => validateArchiveListing(`bundle/teal\n${extra}`), /Unexpected distribution archive entry/);
    }
    assert.throws(() => validateArchiveListing('bundle/teal\nbundle/teal'), /Unexpected distribution archive entry/);
});
