import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolchainUpdates, type UpdateHost, type UpdateSettings } from '../src/toolchainUpdates';

function fixture() {
    const settings: UpdateSettings = { trusted: true, supported: true, autoUpdate: true, release: 'latest', local: false };
    const calls: Array<{ release: string; force: boolean }> = [];
    const applied: string[] = [];
    const host: UpdateHost = {
        settings: async () => ({ ...settings }),
        install: async (release, options) => { calls.push({ release, force: options.force }); return 'installed'; },
        apply: async directory => { applied.push(directory); },
        log: () => {},
    };
    return { settings, calls, applied, host };
}

test('initial installation becomes ready before language clients refresh', async () => {
    const f = fixture();
    const updates = new ToolchainUpdates(f.host);
    f.host.apply = async directory => { await updates.ready(); f.applied.push(directory); };
    assert.equal(await updates.check(), 'installed');
    assert.deepEqual(f.calls, [{ release: 'latest', force: false }]);
    assert.deepEqual(f.applied, ['installed']);
    await updates.dispose();
});

test('automatic checks honor trust, platform, local priority and the opt-out', async () => {
    for (const patch of [{ trusted: false }, { supported: false }, { local: true }, { autoUpdate: false }]) {
        const f = fixture(); Object.assign(f.settings, patch);
        const updates = new ToolchainUpdates(f.host);
        await updates.check();
        assert.equal(f.calls.length, 0);
        await updates.check(true);
        assert.equal(f.calls.length, 'autoUpdate' in patch ? 1 : 0);
        await updates.dispose();
    }
});

test('configuration changes cancel the old request and check the new selection', async () => {
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    f.host.install = async (_release, options) => {
        if (!first) { assert.equal(await options.canCommit(), true); return 'new'; }
        first = false; entered();
        await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        return 'old';
    };
    const updates = new ToolchainUpdates(f.host);
    const previous = updates.check();
    void previous.catch(() => {});
    await started;
    f.settings.release = 'toolchain-v2.0.0';
    await updates.configurationChanged();
    await updates.check();
    await assert.rejects(previous, /cancelled/);
    assert.deepEqual(f.applied, ['new']);
    await updates.dispose();
});

test('commit eligibility is re-read after trust or configuration changes', async () => {
    const f = fixture();
    f.host.install = async (_release, options) => {
        assert.equal(await options.canCommit(), true);
        f.settings.trusted = false;
        assert.equal(await options.canCommit(), false);
        f.settings.trusted = true; f.settings.release = 'fixed';
        assert.equal(await options.canCommit(), false);
        return undefined;
    };
    const updates = new ToolchainUpdates(f.host);
    await updates.check();
    assert.deepEqual(f.applied, []);
    await updates.dispose();
});

test('disposal cancels pending work without applying a completed download', async () => {
    const f = fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.host.install = async (_release, options) => {
        entered();
        await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
        return 'late';
    };
    const updates = new ToolchainUpdates(f.host);
    const pending = updates.check();
    await started;
    await updates.dispose();
    await pending;
    assert.deepEqual(f.applied, []);
});

test('an explicit check queued behind an automatic check still bypasses throttling', async () => {
    const f = fixture();
    let finish!: () => void;
    f.host.install = async (_release, options) => {
        f.calls.push({ release: 'latest', force: options.force });
        if (!options.force) await new Promise<void>(resolve => { finish = resolve; });
        return undefined;
    };
    const updates = new ToolchainUpdates(f.host);
    const automatic = updates.check();
    await new Promise(resolve => setImmediate(resolve));
    const manual = updates.check(true);
    finish();
    await Promise.all([automatic, manual]);
    assert.deepEqual(f.calls.map(call => call.force), [false, true]);
    await updates.dispose();
});
