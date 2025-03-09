// @ts-check
const configs = require('./gen-webpack.config.js');
const nodeConfig = require('./gen-webpack.node.config.js');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const path = require('path');

// Add CopyWebpackPlugin to copy resources
configs.forEach(config => {
    config.plugins.push(
        new CopyWebpackPlugin({
            patterns: [
                { from: path.resolve(__dirname, '../../resources'), to: '.' }
            ]
        })
    );
});

module.exports = [
    ...configs,
    nodeConfig.config
];
