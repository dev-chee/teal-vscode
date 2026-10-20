import assert from 'node:assert/strict';
import test from 'node:test';
import { executableName, isToolchainTarget, managedToolchainTarget, sameFilePath, supportsExecution, toolchainTargets } from '../src/platform';
import { currentToolchainTarget, linuxLibc } from '../src/hostPlatform';

test('native workspace execution covers local and remote Windows, Linux and macOS hosts', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
        for (const arch of ['x64', 'arm64']) assert.equal(supportsExecution(platform, arch), true);
    }
    assert.equal(supportsExecution('linux', 'arm'), true);
    assert.equal(supportsExecution('darwin', 'arm'), false);
    assert.equal(supportsExecution('win32', 'ia32'), false);
    assert.equal(supportsExecution('freebsd', 'x64'), false);
});

test('managed targets distinguish every desktop architecture and libc ABI', () => {
    const actual = [];
    for (const arch of ['x64', 'arm64']) {
        actual.push(managedToolchainTarget('win32', arch), managedToolchainTarget('darwin', arch));
        actual.push(managedToolchainTarget('linux', arch, { libc: 'glibc' }));
        actual.push(managedToolchainTarget('linux', arch, { libc: 'musl' }));
    }
    actual.push(managedToolchainTarget('linux', 'arm', { libc: 'glibc', armVersion: '7', armFloatAbi: 'hard' }));
    assert.deepEqual(actual.sort(), [...toolchainTargets].sort());
    assert.equal(actual.length, 9);
    for (const target of actual) assert.equal(isToolchainTarget(target), true);
    for (const target of ['web', 'linux-ia32', 'toString', undefined]) assert.equal(isToolchainTarget(target), false);
    assert.equal(managedToolchainTarget('linux', 'x64'), undefined);
    assert.equal(managedToolchainTarget('linux', 'arm', { libc: 'glibc', armVersion: '6', armFloatAbi: 'hard' }), undefined);
    assert.equal(managedToolchainTarget('linux', 'arm', { libc: 'glibc', armVersion: '7', armFloatAbi: 'soft' }), undefined);
    assert.equal(managedToolchainTarget('linux', 'arm', { libc: 'musl', armVersion: '7', armFloatAbi: 'hard' }), undefined);
});

test('libc detection requires positive runtime evidence', () => {
    assert.equal(linuxLibc({ glibcVersionRuntime: '2.35' }, [], false), 'glibc');
    assert.equal(linuxLibc({}, ['/lib/ld-musl-aarch64.so.1'], false), 'musl');
    assert.equal(linuxLibc({}, [], true), 'musl');
    assert.equal(linuxLibc({}, [], false), 'unknown');
});

test('native executable naming and path comparisons follow the workspace host', () => {
    assert.equal(executableName('teal-lsp', 'win32'), 'teal-lsp.exe');
    assert.equal(executableName('teal-lsp', 'linux'), 'teal-lsp');
    assert.equal(executableName('teal-dap', 'darwin'), 'teal-dap');
    assert.equal(sameFilePath('/tmp/Main.tl', '/tmp/main.tl', 'linux'), false);
    assert.equal(sameFilePath('D:\\Teal\\Main.tl', 'd:\\teal\\main.tl', 'win32'), true);
});

test('CI runtime architecture and ABI match the requested distribution', () => {
    if (process.env.DIST_TARGET) assert.equal(currentToolchainTarget(), process.env.DIST_TARGET);
    else if (supportsExecution(process.platform, process.arch)) assert.equal(isToolchainTarget(currentToolchainTarget()), true);
});
