// @ts-check
/**
 * Single-source-of-truth version bumper for the NukeIDE monorepo.
 * Usage: node scripts/bump-version.js <version>
 * Example: node scripts/bump-version.js 1.0.1
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_PACKAGES = ['applications/browser/package.json', 'applications/electron/package.json'];

/**
 * Every workspace package that carries the released version: both apps and
 * every extension package. Discovered from `extensions/*` so a new extension
 * cannot be forgotten.
 *
 * @returns {string[]} workspace-relative package.json paths
 */
function discoverPackages() {
    const packages = [...APP_PACKAGES];
    const extensionsRoot = path.join(ROOT, 'extensions');
    for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const relative = `extensions/${entry.name}/package.json`;
        if (fs.existsSync(path.join(ROOT, relative))) {
            packages.push(relative);
        }
    }
    return packages.sort();
}

/**
 * Package names whose versions are rewritten inside every workspace manifest.
 * Includes the app names so internal app dependencies stay in sync too.
 *
 * @param {readonly string[]} packages workspace-relative package.json paths
 * @returns {string[]} package names
 */
function discoverPackageNames(packages) {
    const names = new Set();
    for (const packagePath of packages) {
        const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, packagePath), 'utf-8'));
        if (typeof manifest.name === 'string' && manifest.name.length > 0) {
            names.add(manifest.name);
        }
    }
    return [...names].sort();
}

/**
 * @param {string} filePath workspace-relative package.json path
 * @param {string} newVersion
 * @param {readonly string[]} packageNames
 */
function bumpFile(filePath, newVersion, packageNames) {
    const absolutePath = path.join(ROOT, filePath);
    if (!fs.existsSync(absolutePath)) {
        console.warn(`Skipping missing file: ${filePath}`);
        return;
    }
    let content = fs.readFileSync(absolutePath, 'utf-8');
    const original = content;

    // Bump the package's own version field
    content = content.replace(/("version"\s*:\s*)"[^"]+"/g, `$1"${newVersion}"`);

    // Bump internal workspace dependency versions
    for (const name of packageNames) {
        const regex = new RegExp(`("${name}"\\s*:\\s*)"[^"]+"`, 'g');
        content = content.replace(regex, `$1"${newVersion}"`);
    }

    if (content !== original) {
        fs.writeFileSync(absolutePath, content, 'utf-8');
        console.log(`✔ Bumped ${filePath}`);
    } else {
        console.log(`  No changes in ${filePath}`);
    }
}

/**
 * @param {string} newVersion
 */
function bumpLerna(newVersion) {
    const lernaPath = path.join(ROOT, 'lerna.json');
    let content = fs.readFileSync(lernaPath, 'utf-8');
    const original = content;
    content = content.replace(/("version"\s*:\s*)"[^"]+"/g, `$1"${newVersion}"`);
    if (content !== original) {
        fs.writeFileSync(lernaPath, content, 'utf-8');
        console.log('✔ Bumped lerna.json');
    }
}

function main() {
    const newVersion = process.argv[2];
    if (!newVersion || !/^\d+\.\d+\.\d+/.test(newVersion)) {
        console.error('Usage: node scripts/bump-version.js <version>');
        console.error('Example: node scripts/bump-version.js 1.0.1');
        process.exit(1);
    }

    const packages = discoverPackages();
    const packageNames = discoverPackageNames(packages);
    for (const pkg of packages) {
        bumpFile(pkg, newVersion, packageNames);
    }
    bumpLerna(newVersion);

    console.log(`\nAll packages bumped to ${newVersion}`);
    console.log('Next: git add -A && git commit -m "chore: bump version to ' + newVersion + '" && git tag v' + newVersion);
}

if (require.main === module) {
    main();
}

module.exports = { ROOT, discoverPackages, discoverPackageNames };
