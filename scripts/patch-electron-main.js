// @ts-check
/**
 * Patches the generated electron-main.js to set THEIA_DEFAULT_PLUGINS
 * so bundled VS Code extensions are loaded in packaged apps.
 */
const fs = require('fs');
const path = require('path');

const electronMainPath = path.resolve(__dirname, '..', 'applications', 'electron', 'src-gen', 'backend', 'electron-main.js');

if (!fs.existsSync(electronMainPath)) {
    console.warn('[patch-electron-main] electron-main.js not found, skipping patch.');
    process.exit(0);
}

let content = fs.readFileSync(electronMainPath, 'utf-8');

// Avoid double-patching
if (content.includes('THEIA_DEFAULT_PLUGINS')) {
    console.log('[patch-electron-main] Already patched, skipping.');
    process.exit(0);
}

const marker = 'process.env.THEIA_APP_PROJECT_PATH = theiaAppProjectPath;';
const injection = `
    // Bundled plugins (packaged app) or project-root plugins (dev)
    const pluginsDir = resolve(theiaAppProjectPath, 'plugins');
    const devPluginsDir = resolve(theiaAppProjectPath, '..', '..', 'plugins');
    const fs = require('fs');
    const activePluginsDir = fs.existsSync(pluginsDir) ? pluginsDir : devPluginsDir;
    if (fs.existsSync(activePluginsDir)) {
        process.env.THEIA_DEFAULT_PLUGINS = 'local-dir:' + activePluginsDir;
    }`;

if (!content.includes(marker)) {
    console.error('[patch-electron-main] Could not find injection marker in electron-main.js');
    process.exit(1);
}

content = content.replace(marker, marker + injection);
fs.writeFileSync(electronMainPath, content, 'utf-8');
console.log('[patch-electron-main] Patched electron-main.js successfully.');
