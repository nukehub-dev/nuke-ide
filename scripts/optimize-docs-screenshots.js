#!/usr/bin/env node
/**
 * Quantize freshly captured docs screenshots to indexed PNGs.
 *
 * The capture spec writes truecolor PNGs. UI screenshots use a small palette,
 * so 256-color indexed PNGs are roughly half the size while remaining visually
 * identical. Already-indexed images are skipped, making repeated runs a no-op
 * instead of degrading the palette again.
 *
 * Usage:
 *   node scripts/optimize-docs-screenshots.js
 *   node scripts/optimize-docs-screenshots.js --help
 */

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const UPNG = require('upng-js');

const ROOT_DIR = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT_DIR, 'docs', 'screenshots.json');
const MANIFEST_LABEL = 'docs/screenshots.json';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const INDEXED_COLOR_TYPE = 3;

/** @param {string} file */
function repoPath(file) {
    return path.relative(ROOT_DIR, file).split(path.sep).join('/');
}

/** Read the IHDR fields used by the optimizer. */
function readPngHeader(file) {
    const buffer = Buffer.alloc(26);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (buffer.length < 26 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return undefined;
    }
    if (buffer.readUInt32BE(8) !== 13 || buffer.toString('latin1', 12, 16) !== 'IHDR') {
        return undefined;
    }
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
        bitDepth: buffer[24],
        colorType: buffer[25]
    };
}

/** Quantize one truecolor PNG in place. Returns the byte savings. */
function optimizeFile(file) {
    const header = readPngHeader(file);
    if (!header) {
        throw new Error(`not a valid PNG: ${repoPath(file)}`);
    }
    if (header.colorType === INDEXED_COLOR_TYPE) {
        return { skipped: true, before: 0, after: 0 };
    }

    const before = fs.statSync(file).size;
    const source = fs.readFileSync(file);
    const png = PNG.sync.read(source);
    const pixels = png.data.buffer.slice(png.data.byteOffset, png.data.byteOffset + png.data.byteLength);
    const encoded = Buffer.from(UPNG.encode([pixels], png.width, png.height, 256));
    // The checker requires indexed PNGs; write the quantized form even when a
    // rare high-color image does not shrink, instead of leaving a truecolor file
    // that would fail every subsequent run.
    fs.writeFileSync(file, encoded);
    return { skipped: false, before, after: encoded.length };
}

function printUsage() {
    console.log('Usage: node scripts/optimize-docs-screenshots.js');
    console.log('');
    console.log('Quantizes every truecolor PNG declared in docs/screenshots.json to an indexed PNG.');
    console.log('Already-indexed images are skipped, so repeated runs do not degrade them.');
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        return;
    }
    if (args.length > 0) {
        console.error(`[docs-screenshots] Unknown argument: ${args[0]}`);
        printUsage();
        process.exitCode = 2;
        return;
    }
    if (!fs.existsSync(MANIFEST_PATH)) {
        console.error(`[docs-screenshots] Missing ${MANIFEST_LABEL}`);
        process.exitCode = 1;
        return;
    }

    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    } catch (error) {
        console.error(`[docs-screenshots] Invalid ${MANIFEST_LABEL}: ${error.message}`);
        process.exitCode = 1;
        return;
    }
    if (!manifest || !Array.isArray(manifest.screenshots)) {
        console.error(`[docs-screenshots] ${MANIFEST_LABEL} has no screenshots array`);
        process.exitCode = 1;
        return;
    }

    let beforeTotal = 0;
    let afterTotal = 0;
    let changed = 0;
    let skipped = 0;
    for (const entry of manifest.screenshots) {
        if (!entry || typeof entry.file !== 'string') {
            continue;
        }
        const file = path.resolve(ROOT_DIR, entry.file);
        if (!fs.existsSync(file)) {
            console.error(`[docs-screenshots] missing ${entry.file}; run the capture first`);
            process.exitCode = 1;
            return;
        }
        try {
            const result = optimizeFile(file);
            if (result.skipped) {
                skipped++;
                console.log(`[docs-screenshots] keep ${entry.file} (already indexed)`);
                continue;
            }
            changed++;
            beforeTotal += result.before;
            afterTotal += result.after;
            const saved = ((1 - result.after / result.before) * 100).toFixed(0);
            console.log(
                `[docs-screenshots] optimized ${entry.file}: ${(result.before / 1024).toFixed(1)} KiB -> ` +
                    `${(result.after / 1024).toFixed(1)} KiB (-${saved}%)`
            );
        } catch (error) {
            console.error(`[docs-screenshots] ${error.message}`);
            process.exitCode = 1;
            return;
        }
    }

    if (changed > 0) {
        const saved = ((1 - afterTotal / beforeTotal) * 100).toFixed(0);
        console.log(
            `[docs-screenshots] optimized ${changed} image(s): ${(beforeTotal / 1024).toFixed(1)} KiB -> ` +
                `${(afterTotal / 1024).toFixed(1)} KiB (-${saved}%); skipped ${skipped}`
        );
    } else {
        console.log(`[docs-screenshots] all ${skipped} screenshots already indexed; nothing to do`);
    }
}

if (require.main === module) {
    main();
}
