import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { waitForWatcher } from './watcherReadiness';

test('watcher readiness retries probes lost before listener installation', async () => {
    const events = new EventEmitter();
    let attempts = 0;
    let observed = false;
    await waitForWatcher(async () => {
        attempts++;
        if (attempts === 3) events.on('change', () => { observed = true; });
        events.emit('change');
    }, () => observed, 'watcher never became ready', { timeoutMs: 2000, retryMs: 5, pollMs: 1 });
    assert.equal(attempts, 3, 'writes before registration must not count as readiness');
    assert.equal(observed, true);
});

test('watcher readiness rejects when probes are never observed', async () => {
    let attempts = 0;
    await assert.rejects(waitForWatcher(async () => { attempts++; }, () => false,
        'external dependency watcher never became ready', { timeoutMs: 30, retryMs: 5, pollMs: 1 }),
    /external dependency watcher never became ready/);
    assert.ok(attempts > 0);
});

test('watcher readiness preserves probe failures', async () => {
    const failure = new Error('fixture write failed');
    await assert.rejects(waitForWatcher(async () => { throw failure; }, () => false, 'watcher timeout'), error => error === failure);
});
