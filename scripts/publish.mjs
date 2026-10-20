import { publishVSIX } from '@vscode/vsce';
import { publishDesktopPackages } from './publishing.mjs';

await publishDesktopPackages(publishVSIX, process.env.VSCE_PAT);
