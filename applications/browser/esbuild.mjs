/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 */
import { browserOptions, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';
import { exposeModulePlugin } from '@theia/bundle-plugin';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import esbuild from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
browserOptions.entryPoints['tess-parse.worker'] = resolve(
    repoRoot,
    'extensions/nuke-cad/lib/browser/widgets/cad-viewport/tess-parse.worker.js'
);
browserOptions.plugins.push(exposeModulePlugin());

const browserContext = await esbuild.context(browserOptions);
const nodeContext = await esbuild.context(nodeOptions);

if (watch) {
    await Promise.all([browserContext.watch(), nodeContext.watch()]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
    } catch {
        process.exit(1);
    }
}
