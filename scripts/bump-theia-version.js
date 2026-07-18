// @ts-check
/**
 * Bumps the @theia monorepo dependency version across all workspace package.json files.
 * Usage: node scripts/bump-theia-version.js <version>
 * Example: node scripts/bump-theia-version.js 1.72.3
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();

const IGNORED_DIRS = ['node_modules', 'dist', 'lib', '.git'];

/**
 * @param {string} dir
 * @returns {string[]}
 */
function findPackageJsonFiles(dir) {
    /** @type {string[]} */
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (IGNORED_DIRS.includes(entry.name) || entry.name.startsWith('.')) {
            continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findPackageJsonFiles(fullPath));
        } else if (entry.name === 'package.json') {
            results.push(fullPath);
        }
    }
    return results;
}

/**
 * @param {string} filePath
 * @param {string} newVersion
 */
function bumpTheiaVersion(filePath, newVersion) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const pkg = JSON.parse(content);
    let modified = false;

    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = pkg[section];
        if (!deps || typeof deps !== 'object') {
            continue;
        }
        for (const [name, version] of Object.entries(deps)) {
            if (name.startsWith('@theia/') && typeof version === 'string') {
                deps[name] = newVersion;
                modified = true;
            }
        }
    }

    if (!modified) {
        console.log(`  No Theia deps in ${filePath}`);
        return;
    }

    fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
    console.log(`✔ Bumped Theia deps in ${filePath}`);
}

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+/.test(newVersion)) {
    console.error('Usage: node scripts/bump-theia-version.js <version>');
    console.error('Example: node scripts/bump-theia-version.js 1.72.3');
    process.exit(1);
}

const packageFiles = findPackageJsonFiles(ROOT_DIR).filter((filePath) => !filePath.includes(`${path.sep}node_modules${path.sep}`));

for (const filePath of packageFiles) {
    bumpTheiaVersion(filePath, newVersion);
}

console.log(`\nAll @theia dependencies bumped to ${newVersion}`);
console.log('Next: yarn install');
