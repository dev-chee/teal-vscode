import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { prepareDebugConfiguration, resolvePermissionFile, runtimeTiers, validateLaunchOptions } from '../src/debugOptions';

test('launch.json completion advertises the current DAP contract', async () => {
    const manifest = JSON.parse(await readFile(path.join(__dirname, '../../package.json'), 'utf8'));
    const properties = manifest.contributes.debuggers[0].configurationAttributes.launch.properties;
    assert.deepEqual(properties.tier.enum, [...runtimeTiers]);
    assert.equal(properties.tier.default, 'agentic');
    assert.equal(properties.permissionFile.type, 'string');
    for (const field of ['runtimeProfile', 'allowCapabilities', 'allowReadFiles', 'allowReadDirectories',
        'allowWriteFiles', 'allowWriteDirectories', 'allowExecutables', 'allowEnvironment']) {
        assert.ok(!(field in properties), `${field} must not be offered by launch.json completion`);
    }
});

test('launch accepts current tiers, permission files, lint levels and program arguments', () => {
    validateLaunchOptions({});
    for (const tier of runtimeTiers) {
        const config = {
            tier, permissionFile: '权限 with spaces.toml', args: ['--flag', '中文 argument'],
            allow: ['unused_variable'], warn: [], deny: [], forbid: [], compilerDebug: false, stopOnEntry: true,
        };
        const original = structuredClone(config);
        validateLaunchOptions(config);
        assert.deepEqual(config, original);
    }
});

test('launch rejects removed authorization fields even when empty or combined with permissionFile', () => {
    assert.throws(() => validateLaunchOptions({ runtimeProfile: 'native', tier: 'hosted' }), /runtimeProfile.*use tier/);
    for (const field of [
        'allowCapabilities', 'allowReadFiles', 'allowReadDirectories', 'allowWriteFiles',
        'allowWriteDirectories', 'allowExecutables', 'allowEnvironment', 'allowModules',
    ]) {
        for (const value of [[], null, undefined]) {
            assert.throws(() => validateLaunchOptions({ [field]: value, permissionFile: 'permissions.toml' }), /removed; use permissionFile/);
        }
    }
    for (const field of ['entry', 'entryPoints', 'features', 'extensions', 'env']) {
        assert.throws(() => validateLaunchOptions({ [field]: [] }), /does not support/);
    }
});

test('launch rejects invalid tiers and malformed options before passing them to DAP', () => {
    for (const tier of ['core', 'native', 'web', 'agent', '', null, undefined, 1]) {
        assert.throws(() => validateLaunchOptions({ tier }), /tier must be/);
    }
    for (const permissionFile of ['', '  ', null, undefined, [], true]) {
        assert.throws(() => validateLaunchOptions({ permissionFile }), /permissionFile must be/);
    }
    for (const field of ['args', 'allow', 'warn', 'deny', 'forbid']) {
        for (const value of ['unused_variable', [1], null]) {
            assert.throws(() => validateLaunchOptions({ [field]: value }), /array of strings/);
        }
    }
    for (const field of ['compilerDebug', 'stopOnEntry']) {
        assert.throws(() => validateLaunchOptions({ [field]: 'false' }), /must be a boolean/);
    }
});

test('permissionFile resolves against debug cwd and rejects directories or missing files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-debug-options-'));
    try {
        const cwd = path.join(root, '工作目录');
        await mkdir(cwd);
        const file = path.join(cwd, '权限 with spaces.toml');
        await writeFile(file, '[permissions]\nrules = []\n');
        assert.equal(await resolvePermissionFile('权限 with spaces.toml', cwd), file);
        assert.equal(await resolvePermissionFile(file, root), file);
        await assert.rejects(resolvePermissionFile('.', cwd), /existing local file/);
        await assert.rejects(resolvePermissionFile('missing.toml', cwd), /existing local file/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('attach normalizes IPv6 without mutating input and rejects malformed brackets or credentials', async () => {
    const context = { baseDirectory: tmpdir(), documents: [] };
    const config = { type: 'teal', request: 'attach', name: 'attach', host: '::1', port: 4711, token: 'test-token' };
    const resolved = await prepareDebugConfiguration(config, context);
    assert.equal(resolved.host, '[::1]');
    assert.equal(config.host, '::1');
    assert.equal((await prepareDebugConfiguration({ ...config, host: '[::1]' }, context)).host, '[::1]');
    for (const host of ['[::1', '::1]', 'example.com', '']) {
        await assert.rejects(prepareDebugConfiguration({ ...config, host }, context), /IP address/);
    }
    await assert.rejects(prepareDebugConfiguration({ ...config, port: 0 }, context), /port/);
    await assert.rejects(prepareDebugConfiguration({ ...config, token: '' }, context), /token/);
});

test('launch resolves relative paths into a new configuration and copies argument arrays', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'teal-config-normalize-'));
    try {
        await writeFile(path.join(root, 'main.tl'), 'fn main() {}\n');
        await writeFile(path.join(root, 'permissions.toml'), '[permissions]\nrules = []\n');
        const input = { type: 'teal', request: 'launch', name: 'launch', program: 'main.tl', permissionFile: 'permissions.toml', args: ['first'] };
        const original = structuredClone(input);
        const result = await prepareDebugConfiguration(input, { baseDirectory: root, workspaceDirectory: root, documents: [] });
        assert.equal(result.program, path.join(root, 'main.tl'));
        assert.equal(result.cwd, root);
        assert.equal(result.permissionFile, path.join(root, 'permissions.toml'));
        assert.equal(result.console, 'integratedTerminal');
        assert.deepEqual(input, original);
        input.args.push('second');
        assert.deepEqual(result.args, ['first']);
    } finally { await rm(root, { recursive: true, force: true }); }
});
