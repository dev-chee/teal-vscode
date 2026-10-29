import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { compileTests, projectRoot, runNode } from './test-support.mjs';

const integration = process.argv.includes('--toolchain');
if (integration && !process.env.TEAL_TOOLCHAIN_PATH) throw new Error('TEAL_TOOLCHAIN_PATH must point at rebuilt native Teal executables.');
compileTests();
const suffix = integration ? '.integration.js' : '.test.js';
const tests = readdirSync(path.join(projectRoot, 'out-test/tests'))
  .filter((name) => name.endsWith(suffix) && name !== 'extensionHost.test.js')
  .map((name) => path.join('out-test/tests', name));
if (!tests.length) throw new Error(`No compiled ${integration ? 'toolchain' : 'unit'} tests found.`);
runNode('--test', ...tests, ...(!integration ? ['scripts/toolchain-release.test.mjs', 'scripts/verify-toolchain.test.mjs', 'scripts/bundled-toolchain.test.mjs', 'scripts/publishing.test.mjs', 'scripts/gitlab-release.test.mjs', 'scripts/release-packages.test.mjs', 'scripts/test-support.test.mjs', 'scripts/ci-node.test.mjs'] : []));
