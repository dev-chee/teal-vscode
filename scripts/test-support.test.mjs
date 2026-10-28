import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { hostExtensionPath, projectRoot } from './test-support.mjs';

test('normal activation and automatic update suites use the real extension entry point', () => {
  for (const suite of [undefined, 'extensionHost.test.js', 'toolchainUpdate.host.js']) {
    assert.equal(hostExtensionPath(suite, 'unused-profile'), projectRoot);
  }
});

test('manual lifecycle suites keep automatic activation separate and retain all contributed resources', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'teal-manual-host-'));
  try {
    const original = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    for (const suite of ['toolchainFolders.host.js', 'toolchainRecovery.host.js']) {
      const directory = hostExtensionPath(suite, profile);
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      assert.equal(manifest.publisher, original.publisher);
      assert.equal(manifest.name, original.name);
      assert.deepEqual(manifest.contributes, original.contributes);
      assert.notEqual(manifest.main, original.main);
      const entry = createRequire(path.join(directory, 'package.json'))(manifest.main);
      assert.equal(entry.activate(), undefined);
      assert.equal(entry.deactivate(), undefined);
      const resources = [
        ...manifest.contributes.languages.map(language => language.configuration),
        ...manifest.contributes.grammars.map(grammar => grammar.path),
        ...manifest.contributes.snippets.map(snippets => snippets.path),
      ].filter(Boolean);
      for (const resource of resources) {
        assert.deepEqual(await readFile(path.join(directory, resource)), await readFile(path.join(projectRoot, resource)));
      }
    }
  } finally { await rm(profile, { recursive: true, force: true }); }
});
