import { publishVSIX } from '@vscode/vsce';
import { publishDesktopPackages } from './publishing.mjs';
import { readFile } from 'node:fs/promises';
import { validateReleasePlan } from './gitlab-release-core.mjs';

// GitLab 发布必须携带准备计划；保留其他入口原有的已打包发布 API。
const plan = process.env.GITLAB_CI ? validateReleasePlan(JSON.parse(await readFile('target/release.json', 'utf8')), process.env.CI_COMMIT_SHA) : undefined;
await publishDesktopPackages(publishVSIX, process.env.VSCE_PAT, process.cwd(), plan);
