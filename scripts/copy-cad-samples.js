#!/usr/bin/env node
/**
 * Generate bundled nuke-cad JSON (example projects and component-template
 * bodies) from the canonical e2e `.nuke-cad` fixtures.
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
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_box.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_box.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_cylinder.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_cylinder.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_tube.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_tube.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_sphere.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_sphere.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_cone.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_cone.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_plate_with_hole.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_plate_with_hole.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_l_bracket.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_l_bracket.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_flange.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_flange.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_stepped_shaft.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_stepped_shaft.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_pipe_with_bore.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_pipe_with_bore.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_bolt_circle_plate.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_bolt_circle_plate.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_hex_cell.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_hex_cell.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_control_rod_guide_tube.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_control_rod_guide_tube.json'
    },
    {
        source: 'extensions/nuke-cad/tests/e2e/assets/gui_assembly_grid_plate.nuke-cad',
        target: 'extensions/nuke-cad/src/common/samples/gui_assembly_grid_plate.json'
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
