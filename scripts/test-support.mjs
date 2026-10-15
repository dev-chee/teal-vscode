import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

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
