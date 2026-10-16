import assert from 'node:assert/strict';
import test from 'node:test';
import { validateArchiveListing } from '../src/toolchainDownloadCore';

test('managed archives reject traversal and absolute paths', () => {
    assert.doesNotThrow(() => validateArchiveListing('teal-0.1.0/bin/teal\nteal-0.1.0/runtime/manifest.json'));
    assert.throws(() => validateArchiveListing('../outside/teal'), /unsafe path/);
    assert.throws(() => validateArchiveListing('/absolute/teal'), /unsafe path/);
    assert.throws(() => validateArchiveListing('C:\\outside\\teal'), /unsafe path/);
});
