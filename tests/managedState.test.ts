import assert from 'node:assert/strict';
import test from 'node:test';
import { parseManagedState } from '../src/managedState';
import { toolchainTargets } from '../src/platform';

test('all desktop caches are accepted only by the matching host ABI', () => {
    for (const target of toolchainTargets) {
        const state = { directory: '/toolchains/current', release: 'toolchain-v2', target };
        assert.deepEqual(parseManagedState(state, target), state);
        for (const other of toolchainTargets.filter((candidate) => candidate !== target)) {
            assert.equal(parseManagedState(state, other), undefined);
        }
        assert.equal(parseManagedState(state, undefined), undefined);
    }
});

test('invalid or obsolete platform state does not become an executable path', () => {
    for (const state of [null, '', {}, { directory: '/tools', release: 'v1', target: 'web' },
        { directory: 17, release: 'v1', target: 'linux-x64' }, { directory: '/tools', target: 'linux-x64' }]) {
        assert.equal(parseManagedState(state, 'linux-x64'), undefined);
    }
});
