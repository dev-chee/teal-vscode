import { readFile } from 'node:fs/promises';
import { validateMarketplaceTag } from './publishing.mjs';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.CI_COMMIT_TAG || JSON.parse(await readFile('target/release.json', 'utf8')).extension.tag;
validateMarketplaceTag(tag, manifest.version);
console.log(`Validated Marketplace release ${tag}`);
