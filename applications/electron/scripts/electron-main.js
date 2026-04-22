const path = require('path');
const fs = require('fs');

// Detect if running inside packaged ASAR
const isInsideAsar = __dirname.includes('.asar');

// Compute the plugins directory path.
// In packaged apps, plugins are placed in extraResources at resources/app/plugins.
// In dev mode, they may be at the project root (../../plugins relative to app dir)
// or in the app directory itself (../plugins relative to scripts dir).
const bundledPluginsDir = isInsideAsar
    ? path.join(process.resourcesPath, 'app', 'plugins')
    : path.resolve(__dirname, '..', 'plugins');

const devPluginsDir = path.resolve(__dirname, '..', '..', '..', 'plugins');
const activePluginsDir = fs.existsSync(bundledPluginsDir) ? bundledPluginsDir : devPluginsDir;

if (fs.existsSync(activePluginsDir)) {
    process.env.THEIA_DEFAULT_PLUGINS = `local-dir:${activePluginsDir}`;
}

// Handover to the bundled backend electron main.
require('../lib/backend/electron-main.js');
