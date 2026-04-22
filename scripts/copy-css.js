// @ts-check
/**
 * Cross-platform CSS file copier for Theia extensions.
 * Copies .css files from src/ to lib/ preserving directory structure.
 * Usage: node ../../scripts/copy-css.js
 */
const fs = require('fs');
const path = require('path');

/**
 * @param {string} dir
 * @param {string[]} [files]
 * @returns {string[]}
 */
function findCssFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findCssFiles(fullPath, files);
    } else if (entry.name.endsWith('.css')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * @param {string} src
 * @param {string} dest
 */
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const srcDir = path.resolve('src');
const libDir = path.resolve('lib');

if (!fs.existsSync(srcDir)) {
  console.log('No src directory, skipping CSS copy.');
  process.exit(0);
}

const cssFiles = findCssFiles(srcDir);
if (cssFiles.length === 0) {
  console.log('No CSS files found, nothing to copy.');
  process.exit(0);
}

for (const file of cssFiles) {
  const relative = path.relative(srcDir, file);
  const dest = path.join(libDir, relative);
  copyFile(file, dest);
  console.log(`Copied ${relative}`);
}

console.log(`Done. Copied ${cssFiles.length} CSS file(s).`);
