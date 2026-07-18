// @ts-check
/**
 * Single-source-of-truth version bumper for the NukeIDE monorepo.
 * Usage: node scripts/bump-version.js <version>
 * Example: node scripts/bump-version.js 1.0.1
 */
const fs = require('fs');

const PACKAGES = [
    'applications/browser/package.json',
    'applications/electron/package.json',
    'extensions/nuke-core/package.json',
    'extensions/nuke-docs/package.json',
    'extensions/nuke-essentials/package.json',
    'extensions/nuke-sysmon/package.json',
    'extensions/nuke-fileinfo/package.json',
    'extensions/nuke-visualizer/package.json',
    'extensions/openmc-studio/package.json',
    'extensions/nukelab-integration/package.json'
];

const PACKAGE_NAMES = [
    'nuke-core',
    'nuke-docs',
    'nuke-essentials',
    'nuke-sysmon',
    'nuke-fileinfo',
    'nuke-visualizer',
    'openmc-studio',
    'nukelab-integration',
    'nuke-ide',
    'nuke-ide-electron'
];

/**
 * @param {string} filePath
 * @param {string} newVersion
 */
function bumpFile(filePath, newVersion) {
    if (!fs.existsSync(filePath)) {
        console.warn(`Skipping missing file: ${filePath}`);
        return;
    }
    let content = fs.readFileSync(filePath, 'utf-8');
    const original = content;

    // Bump the package's own version field
    content = content.replace(/("version"\s*:\s*)"[^"]+"/g, `$1"${newVersion}"`);

    // Bump internal workspace dependency versions
    for (const name of PACKAGE_NAMES) {
        const regex = new RegExp(`("${name}"\\s*:\\s*)"[^"]+"`, 'g');
        content = content.replace(regex, `$1"${newVersion}"`);
    }

    if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log(`✔ Bumped ${filePath}`);
    } else {
        console.log(`  No changes in ${filePath}`);
    }
}

/**
 * @param {string} newVersion
 */
function bumpLerna(newVersion) {
    const lernaPath = 'lerna.json';
    let content = fs.readFileSync(lernaPath, 'utf-8');
    const original = content;
    content = content.replace(/("version"\s*:\s*)"[^"]+"/g, `$1"${newVersion}"`);
    if (content !== original) {
        fs.writeFileSync(lernaPath, content, 'utf-8');
        console.log(`✔ Bumped ${lernaPath}`);
    }
}

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+/.test(newVersion)) {
    console.error('Usage: node scripts/bump-version.js <version>');
    console.error('Example: node scripts/bump-version.js 1.0.1');
    process.exit(1);
}

for (const pkg of PACKAGES) {
    bumpFile(pkg, newVersion);
}
bumpLerna(newVersion);

console.log(`\nAll packages bumped to ${newVersion}`);
console.log('Next: git add -A && git commit -m "chore: bump version to ' + newVersion + '" && git tag v' + newVersion);
