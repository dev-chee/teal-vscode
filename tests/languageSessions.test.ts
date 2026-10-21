import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LanguageSessions, type LanguageGroup, type LanguageSession, type LanguageSessionHost } from '../src/languageSessions';

function document(file: string) { return { path: file, uri: pathToFileURL(file).toString() }; }
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

async function fixture(start = true) {
    const root = path.join(tmpdir(), 'teal-session-regression');
    const main = document(path.join(root, 'main.tl'));
    const lib = document(path.join(root, 'child', 'lib.tl'));
    const parent = { key: 'parent', root, documents: [main] };
    const child = { key: 'child', root: path.join(root, 'child'), documents: [lib] };
    const groups = [parent, child];
    const created: Session[] = [];
    const errors: unknown[] = [];
    class Session implements LanguageSession {
        running = true;
        disposed = false;
        beforeDispose?: () => void;
        constructor(readonly group: LanguageGroup) { created.push(this); }
        isRunning() { return this.running; }
        async dispose() { this.beforeDispose?.(); this.disposed = true; this.running = false; }
    }
    const host: LanguageSessionHost<LanguageGroup> = {
        groups: () => groups,
        start: async (group) => new Session(group),
        report: (error) => { errors.push(error); },
    };
    const manager = new LanguageSessions(host);
    if (start) { await manager.refresh(); assert.equal(created.length, 2); }
    return {
        manager, host, parent, child, main, lib, groups, created, errors,
        count: (group: LanguageGroup) => created.filter((session) => session.group.key === group.key).length,
        async dispose() { await manager.dispose(); assert.deepEqual(errors, []); },
    };
}

test('saving a nested dependency restarts only clients that do not synchronize its buffer', async () => {
    const f = await fixture();
    try {
        f.manager.diskChanged(f.lib);
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
        assert.equal(f.count(f.child), 1);
        f.manager.diskChanged(f.main);
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
    } finally { await f.dispose(); }
});

test('an unsynchronized file refreshes its containing root without affecting unrelated roots', async () => {
    const f = await fixture();
    try {
        f.manager.diskChanged(document(path.join(f.parent.root, 'other.tl')));
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
        assert.equal(f.count(f.child), 1);
        f.manager.diskChanged(document(`${f.parent.root}-sibling/other.tl`));
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
    } finally { await f.dispose(); }
});

test('disk events received while another client stops survive the current refresh', async () => {
    const f = await fixture();
    try {
        f.created[1].beforeDispose = () => f.manager.diskChanged(document(path.join(f.parent.root, 'new.tl')));
        f.groups.splice(1);
        await f.manager.refresh();
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
    } finally { await f.dispose(); }
});

test('configuration changes during initial startup restart the in-flight session', async () => {
    const f = await fixture(false);
    const entered = deferred();
    const release = deferred();
    const start = f.host.start;
    f.host.start = async (group) => {
        const session = await start(group);
        if (f.created.length === 1) { entered.resolve(); await release.promise; }
        return session;
    };
    try {
        const refresh = f.manager.refresh();
        await entered.promise;
        f.manager.schedule(true);
        release.resolve();
        await refresh;
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
        assert.equal(f.count(f.child), 2);
    } finally { release.resolve(); await f.dispose(); }
});

test('deactivation waits for in-flight startup and disposes it without starting further clients', async () => {
    const f = await fixture(false);
    const entered = deferred();
    const release = deferred();
    const start = f.host.start;
    f.host.start = async (group) => { const session = await start(group); entered.resolve(); await release.promise; return session; };
    const refresh = f.manager.refresh();
    await entered.promise;
    const stopped = f.manager.dispose();
    release.resolve();
    await Promise.all([refresh, stopped]);
    assert.equal(f.created.length, 1);
    assert.ok(f.created[0].disposed);
    assert.equal(f.manager.owner(f.main.path), undefined);
    await f.dispose();
});

test('one failed startup does not block other roots or later retries', async () => {
    const f = await fixture(false);
    const start = f.host.start;
    f.host.start = async (group) => { if (group.key === f.parent.key) throw new Error('missing executable'); return start(group); };
    try {
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 0);
        assert.equal(f.count(f.child), 1);
        assert.equal(f.errors.splice(0).length, 1);
        f.host.start = start;
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 1);
        assert.equal(f.count(f.child), 1);
    } finally { await f.dispose(); }
});

test('symbol ownership selects the deepest running root and ignores similar prefixes', async () => {
    const f = await fixture();
    try {
        assert.equal(f.manager.owner(f.lib.path), 'child');
        assert.equal(f.manager.owner(path.join(f.parent.root, 'childish', 'other.tl')), 'parent');
        f.created[1].running = false;
        assert.equal(f.manager.owner(f.lib.path), 'parent');
        assert.equal(f.manager.owner(`${f.parent.root}-other/main.tl`), undefined);
    } finally { await f.dispose(); }
});

test('symbol ownership resolves linked roots and ranks nested roots by their real paths', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'teal-session-links-'));
    const root = await realpath(directory);
    const actual = path.join(root, 'real');
    const nested = path.join(actual, 'nested');
    const alias = path.join(root, 'a much longer workspace alias');
    await mkdir(nested, { recursive: true });
    await symlink(actual, alias, 'junction');
    const outer = path.join(actual, 'outer.tl');
    const inner = path.join(nested, 'inner.tl');
    await writeFile(outer, '');
    await writeFile(inner, '');
    const groups = [
        { key: 'alias', root: alias, documents: [document(path.join(alias, 'outer.tl'))] },
        { key: 'nested', root: nested, documents: [document(inner)] },
    ];
    const running = new Set(groups.map(group => group.key));
    const manager = new LanguageSessions({
        groups: () => groups,
        start: async group => ({ isRunning: () => running.has(group.key), dispose: async () => { running.delete(group.key); } }),
        report: error => { throw error; },
    });
    try {
        await manager.refresh();
        assert.equal(manager.owner(outer), 'alias', 'canonical LSP locations belong to the linked workspace');
        assert.equal(manager.owner(inner), 'nested', 'the longer alias must not hide the deeper real root');
        assert.equal(manager.owner(path.join(alias, 'unsaved.tl')), 'alias', 'original editor paths remain supported');
        assert.equal(manager.owner(path.join(root, 'real-sibling', 'other.tl')), undefined);
        running.delete('nested');
        assert.equal(manager.owner(inner), 'alias', 'stopped nested sessions fall back to the parent');
    } finally {
        await manager.dispose();
        await rm(directory, { recursive: true, force: true });
    }
});

test('document order does not restart a client but removing its root disposes it', async () => {
    const f = await fixture();
    try {
        f.parent.documents.push(document(path.join(f.parent.root, 'other.tl')));
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
        f.parent.documents.reverse();
        await f.manager.refresh();
        assert.equal(f.count(f.parent), 2);
        f.groups.length = 0;
        await f.manager.refresh();
        assert.ok(f.created.every((session) => session.disposed));
    } finally { await f.dispose(); }
});

test('failed disposal retains its handle, stops other roots and prevents duplicate startup until retry', async () => {
    const f = await fixture();
    try {
        f.created[0].beforeDispose = () => { throw new Error('stop failed'); };
        await assert.rejects(f.manager.refresh(true), /could not be stopped/);
        assert.equal(f.created.length, 2);
        assert.ok(f.created[1].disposed, 'other roots still stop');
        f.created[0].beforeDispose = undefined;
        await f.manager.refresh();
        assert.ok(f.created[0].disposed, 'failed handle is retried');
        assert.equal(f.count(f.parent), 2);
        assert.equal(f.count(f.child), 2);
    } finally { await f.dispose(); }
});

test('strict toolchain refresh propagates startup failure and preserves unrelated roots', async () => {
    const f = await fixture();
    const start = f.host.start;
    try {
        f.host.start = async group => { if (group.key === f.parent.key) throw new Error('new LSP failed'); return start(group); };
        await assert.rejects(f.manager.refreshScopes([f.parent.key], true), /could not be started/);
        assert.equal(f.created[0].disposed, true);
        assert.equal(f.created[1].disposed, false);
        assert.equal(f.errors.splice(0).length, 1);
        f.host.start = start;
        await f.manager.refreshScopes([f.parent.key], true);
        assert.equal(f.count(f.parent), 2);
        assert.equal(f.count(f.child), 1);
        assert.equal(f.manager.owner(f.main.path), f.parent.key);
    } finally { await f.dispose(); }
});

test('scoped refresh leaves pending disk and configuration events for other roots', async () => {
    const f = await fixture();
    try {
        f.manager.diskChanged(document(path.join(f.child.root, 'other.tl')));
        f.manager.schedule(true);
        await f.manager.refreshScopes([f.parent.key]);
        assert.equal(f.count(f.child), 1);
        await f.manager.refresh();
        assert.equal(f.count(f.child), 2);
    } finally { await f.dispose(); }
});
