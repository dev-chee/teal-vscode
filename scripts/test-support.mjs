import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

/** 手动驱动生命周期的用例保留真实语言/配置贡献，自动激活入口不得再次注册命令。 */
export function hostExtensionPath(suite, profile) {
  if (!['toolchainFolders.host.js', 'toolchainRecovery.host.js'].includes(suite)) return projectRoot;
  const directory = path.join(profile, 'manual-extension');
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const resources = new Set([
    ...manifest.contributes.languages.map(language => language.configuration),
    ...manifest.contributes.grammars.map(grammar => grammar.path),
    ...manifest.contributes.snippets.map(snippets => snippets.path),
  ].filter(Boolean));
  mkdirSync(directory, { recursive: true });
  for (const resource of resources) {
    const output = path.join(directory, resource);
    mkdirSync(path.dirname(output), { recursive: true });
    cpSync(path.join(projectRoot, resource), output);
  }
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ ...manifest, main: './extension.cjs' }));
  writeFileSync(path.join(directory, 'extension.cjs'), 'exports.activate = () => {};\nexports.deactivate = () => {};\n');
  return directory;
}

export function runNode(...args) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function compileTests() {
  // 删除已移除或更名测试的旧产物，避免它们继续参与验证。
  rmSync(new URL('../out-test', import.meta.url), { recursive: true, force: true });
  runNode('node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json');
}
