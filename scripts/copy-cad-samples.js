#!/usr/bin/env node
/**
 * Generate the bundled nuke-cad example-project JSON from the canonical e2e
 * `.nuke-cad` fixtures.
 *
 * The extension imports sample documents as JSON modules, but the committed
 * fixtures use the `.nuke-cad` extension. Keep exactly one tracked copy: the
 * fixture. This script writes the generated JSON beside the sample metadata
 * before `tsc` runs. Both generated files are gitignored and prettier-ignored.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const COPIES = [
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_pincell.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_pincell.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/tokamak_with_divertor.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/tokamak_with_divertor.json'
    }
];

let failed = false;
for (const { source: sourceRelative, target: targetRelative } of COPIES) {
    const source = path.join(ROOT_DIR, sourceRelative);
    const target = path.join(ROOT_DIR, targetRelative);
    if (!fs.existsSync(source)) {
        console.error(`[copy-cad-samples] Missing canonical fixture: ${sourceRelative}`);
        failed = true;
        continue;
    }
    const next = fs.readFileSync(source);
    const current = fs.existsSync(target) ? fs.readFileSync(target) : undefined;
    if (current !== undefined && current.equals(next)) {
        console.log(`[copy-cad-samples] up to date: ${targetRelative}`);
        continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next);
    console.log(`[copy-cad-samples] ${sourceRelative} -> ${targetRelative}`);
}

if (failed) {
    process.exitCode = 1;
}
