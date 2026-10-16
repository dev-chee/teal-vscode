import assert from 'node:assert/strict';
import test from 'node:test';
import { executableName, managedToolchainTarget, sameFilePath, supportsExecution } from '../src/platform';

test('execution runs in local Windows or the WSL workspace host', () => {
    assert.equal(supportsExecution('win32', 'x64', undefined, true), true);
    assert.equal(supportsExecution('linux', 'x64', 'wsl', true), true);
    assert.equal(supportsExecution('win32', 'x64', 'wsl', true), false);
    assert.equal(supportsExecution('linux', 'x64', 'ssh-remote', true), false);
    assert.equal(supportsExecution('linux', 'x64', undefined, true), false);
    assert.equal(supportsExecution('linux', 'x64', 'wsl', false), false);
    assert.equal(supportsExecution('linux', 'arm64', 'wsl', true), false);
});

test('managed toolchain targets follow the extension host', () => {
    assert.equal(managedToolchainTarget('win32', 'x64', undefined, true), 'win32-x64');
    assert.equal(managedToolchainTarget('linux', 'x64', 'wsl', true), 'linux-x64');
    assert.equal(managedToolchainTarget('linux', 'x64', undefined, true), undefined);
    assert.equal(managedToolchainTarget('linux', 'arm64', 'wsl', true), undefined);
});

test('WSL uses native executable names and preserves distinct case-sensitive files', () => {
    assert.equal(executableName('teal-lsp', 'win32'), 'teal-lsp.exe');
    assert.equal(executableName('teal-lsp', 'linux'), 'teal-lsp');
    assert.equal(sameFilePath('/tmp/Main.tl', '/tmp/main.tl', 'linux'), false);
    assert.equal(sameFilePath('/tmp/main.tl', '/tmp/main.tl', 'linux'), true);
    assert.equal(sameFilePath('D:\\Teal\\Main.tl', 'd:\\teal\\main.tl', 'win32'), true);
});
