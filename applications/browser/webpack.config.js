// @ts-check
const configs = require('./gen-webpack.config.js');
const nodeConfig = require('./gen-webpack.node.config.js');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const webpack = require('webpack');
const path = require('path');

// Prevent webpack from bundling 'electron' in browser builds.
// electron-only extensions (e.g., updater) may be reachable in some build environments.
configs.forEach(config => {
    if (!config.resolve) {
        config.resolve = {};
    }
    if (!config.resolve.fallback) {
        config.resolve.fallback = {};
    }
    config.resolve.fallback.electron = false;

    if (!config.plugins) {
        config.plugins = [];
    }
    config.plugins.push(
        new CopyWebpackPlugin({
            patterns: [
                { from: path.resolve(__dirname, '../../resources'), to: '.' }
            ]
        })
    );
});

// Ignore Windows-only node-pty native module on non-Windows platforms
if (process.platform !== 'win32') {
    if (!nodeConfig.config.plugins) {
        nodeConfig.config.plugins = [];
    }
    nodeConfig.config.plugins.push(
        new webpack.IgnorePlugin({
            checkResource: resource => resource.includes('conpty_console_list')
        })
    );
}

module.exports = [
    ...configs,
    nodeConfig.config
];
