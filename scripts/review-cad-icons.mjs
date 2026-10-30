#!/usr/bin/env node
/**
 * Review the nuke-cad mask icon set.
 *
 * Parses `extensions/nuke-cad/src/browser/widgets/cad-viewport/cad-icons.css`,
 * writes one SVG per distinct glyph (aliases in a selector group collapse to
 * one file), rasterizes it at 16px and 24px, composes dark/light contact
 * sheets, and emits a metrics report under `.cache/cad-icons/`.
 *
 * This is a manual review tool: metric flags are informational, not a gate.
 * Only parse failures and required-tool failures exit non-zero.
 *
 * Required tools: resvg, ImageMagick 7 (`magick`), oxipng.
 * Optional cross-check: rsvg-convert (a failure only warns).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'extensions', 'nuke-cad', 'src', 'browser', 'widgets', 'cad-viewport', 'cad-icons.css');
const OUT_DIR = path.join(ROOT, '.cache', 'cad-icons');
const SVG_DIR = OUT_DIR;
const PNG16_DIR = path.join(OUT_DIR, 'png', '16');
const PNG24_DIR = path.join(OUT_DIR, 'png', '24');
const WORK_DIR = path.join(OUT_DIR, '.work');
const REPORT_FILE = path.join(OUT_DIR, 'report.json');
const DARK_SHEET = path.join(OUT_DIR, 'sheet.png');
const LIGHT_SHEET = path.join(OUT_DIR, 'sheet-light.png');
const CROSS_CHECK_FILE = path.join(OUT_DIR, 'cross-check-rsvg-convert.png');

const SELECTOR_PREFIX = '.codicon-nuke-cad-';
const SELECTOR_PATTERN = /^\.codicon-nuke-cad-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const GRID_SIZE = 16;
const SECONDARY_SIZE = 24;
const INSET_PX = 1;
const EXPECTED_STROKE_WIDTH = 1.2;
const MIN_COVERAGE = 0.04;
const MAX_COVERAGE = 0.6;
const DUPLICATE_DISTANCE = 1;
const CROSS_CHECK_COVERAGE_TOLERANCE = 0.03;
const SHEET_COLUMNS = 8;
const SHEET_ZOOM = 4;

function fail(message) {
    console.error(`[review-cad-icons] error: ${message}`);
    process.exit(1);
}

function warn(message) {
    console.warn(`[review-cad-icons] warning: ${message}`);
}

function toRepoPath(file) {
    return path.relative(ROOT, file).split(path.sep).join('/');
}

function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    if (result.error) {
        fail(`cannot run ${command}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const stderr = String(result.stderr ?? '').trim();
        fail(`${command} exited with code ${result.status}${stderr ? `: ${stderr}` : ''}`);
    }
    return result;
}

function extractMaskDeclarations(body) {
    const declarations = new Map();
    const pattern = /(?:^|[\s;])(-webkit-mask-image|mask-image)\s*:\s*url\(\s*(['"])(data:image\/svg\+xml,[\s\S]*?)\2\s*\)/g;
    let match;
    while ((match = pattern.exec(body)) !== null) {
        const property = match[1];
        const dataUrl = match[3];
        const urls = declarations.get(property) ?? [];
        if (!urls.includes(dataUrl)) {
            urls.push(dataUrl);
        }
        declarations.set(property, urls);
    }
    return declarations;
}

function decodeSvgPayload(dataUrl, selectors) {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) {
        fail(`mask-image payload for ${selectors.join(', ')} is not a data URL`);
    }
    let svg;
    try {
        svg = decodeURIComponent(dataUrl.slice(comma + 1)).trim();
    } catch (error) {
        fail(`cannot percent-decode mask-image payload for ${selectors.join(', ')}: ${error.message}`);
    }
    if (!svg.startsWith('<svg')) {
        fail(`mask-image payload for ${selectors.join(', ')} does not start with <svg: ${JSON.stringify(svg.slice(0, 48))}`);
    }
    return svg;
}

function parseCss(css) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [];
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = rulePattern.exec(withoutComments)) !== null) {
        const selectors = match[1]
            .split(',')
            .map((selector) => selector.trim())
            .filter((selector) => SELECTOR_PATTERN.test(selector));
        if (selectors.length === 0) {
            continue;
        }
        const body = match[2];
        if (!/mask-image\s*:/.test(body)) {
            continue;
        }
        const declarations = extractMaskDeclarations(body);
        const standard = declarations.get('mask-image') ?? [];
        const webkit = declarations.get('-webkit-mask-image') ?? [];
        if (standard.length > 1 || webkit.length > 1) {
            fail(`${selectors.join(', ')} repeats a mask-image property with multiple data URLs; expected one per property`);
        }
        if (standard.length === 0 && webkit.length === 0) {
            fail(`${selectors.join(', ')} has a mask-image declaration without a data:image/svg+xml URL`);
        }
        // `mask-image` is the forward-looking property; use it when present and
        // record a divergence from the -webkit fallback (both are in the file).
        const standardSvg = standard.length > 0 ? decodeSvgPayload(standard[0], selectors) : null;
        const webkitSvg = webkit.length > 0 ? decodeSvgPayload(webkit[0], selectors) : null;
        blocks.push({
            selectors,
            svg: standardSvg ?? webkitSvg,
            declarationMismatch: standardSvg !== null && webkitSvg !== null && standardSvg !== webkitSvg
        });
    }
    if (blocks.length === 0) {
        fail(`no ${SELECTOR_PREFIX}* mask-image rules found in ${toRepoPath(SOURCE)}`);
    }
    return blocks;
}

function parseSvgMetadata(svg, name) {
    const root = svg.match(/^<svg\b([^>]*)>/);
    if (!root) {
        fail(`SVG for ${name} has no root <svg> element`);
    }
    const attributes = new Map();
    for (const attribute of root[1].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(['"])(.*?)\2/g)) {
        attributes.set(attribute[1], attribute[3]);
    }
    const viewBox = attributes.get('viewBox') ?? null;
    let viewBoxSize = null;
    if (viewBox) {
        const parts = viewBox
            .trim()
            .split(/[\s,]+/)
            .map(Number);
        if (parts.length === 4 && parts.every(Number.isFinite)) {
            viewBoxSize = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
        }
    }
    const strokeWidths = [
        ...new Set(
            [...svg.matchAll(/stroke-width\s*[:=]\s*['"]?([0-9]*\.?[0-9]+)/g)]
                .map((width) => Number.parseFloat(width[1]))
                .filter(Number.isFinite)
        )
    ].sort((a, b) => a - b);
    const rootStroke = (attributes.get('stroke') ?? '').trim().toLowerCase();
    return {
        viewBox,
        viewBoxSize,
        strokeWidths,
        strokeGlyph: (rootStroke !== '' && rootStroke !== 'none') || strokeWidths.length > 0
    };
}

function collectGlyphs(blocks) {
    const bySvg = new Map();
    for (const block of blocks) {
        let glyph = bySvg.get(block.svg);
        if (!glyph) {
            glyph = { svg: block.svg, selectors: [], aliases: [], nearDuplicates: [], declarationMismatch: false };
            bySvg.set(block.svg, glyph);
        }
        glyph.declarationMismatch ||= block.declarationMismatch;
        for (const selector of block.selectors) {
            if (!glyph.selectors.includes(selector)) {
                glyph.selectors.push(selector);
            }
        }
    }
    return [...bySvg.values()].map((glyph) => {
        const names = glyph.selectors.map((selector) => SELECTOR_PATTERN.exec(selector)[1]);
        const name = names[0];
        glyph.name = name;
        glyph.aliases = names.slice(1);
        Object.assign(glyph, parseSvgMetadata(glyph.svg, name));
        return glyph;
    });
}

function readPngSize(file) {
    const buffer = fs.readFileSync(file);
    if (buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        fail(`${toRepoPath(file)} is not a valid PNG`);
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function alphaCoverage(file) {
    const { stdout } = run('magick', [file, '-alpha', 'extract', '-format', '%[fx:mean]', 'info:']);
    const coverage = Number.parseFloat(stdout);
    if (!Number.isFinite(coverage)) {
        fail(`could not read alpha mean from ${toRepoPath(file)}: ${JSON.stringify(stdout)}`);
    }
    return coverage;
}

function trimmedBounds(file) {
    const { stdout } = run('magick', [file, '-trim', '-format', '%wx%h%O', 'info:']);
    const match = /^(\d+)x(\d+)([+-]\d+)([+-]\d+)$/.exec(stdout.trim());
    if (!match) {
        fail(`could not read trimmed bounds from ${toRepoPath(file)}: ${JSON.stringify(stdout)}`);
    }
    return {
        trimmed: stdout.trim(),
        width: Number(match[1]),
        height: Number(match[2]),
        x: Number(match[3]),
        y: Number(match[4])
    };
}

function alphaSignature(file) {
    const result = run('magick', [file, '-alpha', 'extract', '-resize', '4x4!', '-depth', '8', 'gray:-'], {
        encoding: null
    });
    const bytes = result.stdout;
    if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
        fail(`expected a 16-byte 4x4 alpha signature from ${toRepoPath(file)}, got ${bytes?.length ?? 0} bytes`);
    }
    return [...bytes];
}

function signatureDistance(a, b) {
    // Distance is the number of differing bytes across the 16-byte 4x4 alpha
    // signature, so near-duplicate screening never compares rendered images.
    let distance = 0;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) {
            distance++;
        }
    }
    return distance;
}

function findNearDuplicates(glyphs) {
    const pairs = [];
    for (let left = 0; left < glyphs.length; left++) {
        for (let right = left + 1; right < glyphs.length; right++) {
            const distance = signatureDistance(glyphs[left].signature, glyphs[right].signature);
            if (distance <= DUPLICATE_DISTANCE) {
                pairs.push({ a: glyphs[left].name, b: glyphs[right].name, distance });
                glyphs[left].nearDuplicates.push(glyphs[right].name);
                glyphs[right].nearDuplicates.push(glyphs[left].name);
            }
        }
    }
    return pairs;
}

function renderGlyph(glyph) {
    const svgPath = path.join(SVG_DIR, `${glyph.name}.svg`);
    const png16Path = path.join(PNG16_DIR, `${glyph.name}.png`);
    const png24Path = path.join(PNG24_DIR, `${glyph.name}.png`);
    fs.writeFileSync(svgPath, `${glyph.svg}\n`, 'utf8');
    run('resvg', ['-w', String(GRID_SIZE), '-h', String(GRID_SIZE), svgPath, png16Path]);
    run('resvg', ['-w', String(SECONDARY_SIZE), '-h', String(SECONDARY_SIZE), svgPath, png24Path]);

    const canvas = readPngSize(png16Path);
    const coverage = alphaCoverage(png16Path);
    const bounds = trimmedBounds(png16Path);
    const signature = alphaSignature(png16Path);
    const canvasMismatch = canvas.width !== GRID_SIZE || canvas.height !== GRID_SIZE;
    const viewBoxMismatch =
        !glyph.viewBoxSize ||
        glyph.viewBoxSize.x !== 0 ||
        glyph.viewBoxSize.y !== 0 ||
        glyph.viewBoxSize.width !== GRID_SIZE ||
        glyph.viewBoxSize.height !== GRID_SIZE;
    const insetViolation =
        bounds.x < INSET_PX ||
        bounds.y < INSET_PX ||
        bounds.x + bounds.width > GRID_SIZE - INSET_PX ||
        bounds.y + bounds.height > GRID_SIZE - INSET_PX;

    Object.assign(glyph, {
        svgPath,
        png16Path,
        png24Path,
        canvas,
        coverage,
        coverageFlag: coverage < MIN_COVERAGE || coverage > MAX_COVERAGE,
        bounds: { ...bounds, insetViolation, canvasMismatch, viewBoxMismatch },
        boundsFlag: insetViolation || canvasMismatch || viewBoxMismatch,
        strokeFlag: glyph.strokeGlyph && glyph.strokeWidths.some((width) => Math.abs(width - EXPECTED_STROKE_WIDTH) > 1e-9),
        signature
    });
}

function crossCheckRsgvConvert(glyph) {
    const result = spawnSync('rsvg-convert', ['-w', String(GRID_SIZE), '-h', String(GRID_SIZE), '-o', CROSS_CHECK_FILE, glyph.svgPath], {
        encoding: 'utf8'
    });
    if (result.error) {
        warn(`rsvg-convert cross-check skipped: ${result.error.message}`);
        return { glyph: glyph.name, renderer: 'rsvg-convert', ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
        const stderr = String(result.stderr ?? '').trim();
        warn(`rsvg-convert cross-check failed for ${glyph.name}${stderr ? `: ${stderr}` : ''}`);
        return { glyph: glyph.name, renderer: 'rsvg-convert', ok: false, error: stderr || `exit ${result.status}` };
    }
    const canvas = readPngSize(CROSS_CHECK_FILE);
    if (canvas.width !== GRID_SIZE || canvas.height !== GRID_SIZE) {
        warn(`rsvg-convert cross-check rendered ${glyph.name} at ${canvas.width}x${canvas.height}, expected ${GRID_SIZE}x${GRID_SIZE}`);
        return { glyph: glyph.name, renderer: 'rsvg-convert', ok: false, error: `canvas ${canvas.width}x${canvas.height}` };
    }
    const coverage = alphaCoverage(CROSS_CHECK_FILE);
    const coverageDelta = Math.abs(coverage - glyph.coverage);
    if (coverageDelta > CROSS_CHECK_COVERAGE_TOLERANCE) {
        warn(
            `rsvg-convert cross-check coverage for ${glyph.name} differs by ${round(coverageDelta * 100, 1)}% ` +
                `(tolerance ${CROSS_CHECK_COVERAGE_TOLERANCE * 100}%)`
        );
        return {
            glyph: glyph.name,
            renderer: 'rsvg-convert',
            ok: false,
            error: `coverage delta ${round(coverageDelta * 100, 1)}%`,
            coverage: round(coverage, 6),
            coverageDelta: round(coverageDelta, 6)
        };
    }
    return {
        glyph: glyph.name,
        renderer: 'rsvg-convert',
        ok: true,
        canvas,
        coverage: round(coverage, 6),
        coverageDelta: round(coverageDelta, 6),
        png: toRepoPath(CROSS_CHECK_FILE)
    };
}

function buildSheet(glyphs, { background, foreground, output, workDir }) {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    const tiles = glyphs.map((glyph) => {
        const tile = path.join(workDir, `${glyph.name}.png`);
        run('magick', [
            glyph.png16Path,
            '-filter',
            'point',
            '-resize',
            `${SHEET_ZOOM * 100}%`,
            '-fill',
            foreground,
            '-colorize',
            '100',
            tile
        ]);
        return tile;
    });
    run('magick', [
        'montage',
        '-background',
        background,
        '-fill',
        foreground,
        '-pointsize',
        '11',
        '-label',
        '%t',
        '-tile',
        `${SHEET_COLUMNS}x`,
        '-geometry',
        '96x92+8+14',
        '-depth',
        '8',
        ...tiles,
        output
    ]);
}

function inspectMaskDeclarations(css) {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const declarationCount = (withoutComments.match(/(?:-webkit-)?mask-image\s*:/g) ?? []).length;
    const payloads = new Set();
    for (const match of withoutComments.matchAll(/mask-image\s*:\s*url\(\s*(['"])(data:image\/svg\+xml,[\s\S]*?)\1\s*\)/g)) {
        payloads.add(match[2]);
    }
    return { declarationCount, distinctPayloadCount: payloads.size };
}

function glyphIssues(glyph) {
    const issues = [];
    let score = 0;
    if (glyph.coverage < MIN_COVERAGE) {
        issues.push(`coverage ${round(glyph.coverage * 100, 1)}% (<${MIN_COVERAGE * 100}%)`);
        score += (MIN_COVERAGE - glyph.coverage) / MIN_COVERAGE;
    } else if (glyph.coverage > MAX_COVERAGE) {
        issues.push(`coverage ${round(glyph.coverage * 100, 1)}% (>${MAX_COVERAGE * 100}%)`);
        score += (glyph.coverage - MAX_COVERAGE) / (1 - MAX_COVERAGE);
    }
    if (glyph.bounds.insetViolation) {
        issues.push(`bbox ${glyph.bounds.trimmed} breaks the ${INSET_PX}px inset`);
        score += 1;
    }
    if (glyph.bounds.canvasMismatch) {
        issues.push(`canvas ${glyph.canvas.width}x${glyph.canvas.height}`);
        score += 2;
    }
    if (glyph.bounds.viewBoxMismatch) {
        issues.push(`viewBox ${glyph.viewBox ?? 'missing'}`);
        score += 1;
    }
    if (glyph.strokeFlag) {
        issues.push(`stroke-width ${glyph.strokeWidths.join('/')} (expected ${EXPECTED_STROKE_WIDTH})`);
        score += 1;
    }
    if (glyph.declarationMismatch) {
        issues.push('-webkit-mask-image differs from mask-image');
        score += 1.5;
    }
    if (glyph.nearDuplicates.length > 0) {
        issues.push(`near-duplicate ${glyph.nearDuplicates.join(', ')}`);
        score += 0.25 * glyph.nearDuplicates.length;
    }
    return { issues, score };
}

function buildReport(glyphs, blocks, css, crossCheck) {
    const duplicatePairs = findNearDuplicates(glyphs);
    const flagged = {
        coverage: glyphs.filter((glyph) => glyph.coverageFlag).map((glyph) => glyph.name),
        bounds: glyphs.filter((glyph) => glyph.boundsFlag).map((glyph) => glyph.name),
        stroke: glyphs.filter((glyph) => glyph.strokeFlag).map((glyph) => glyph.name),
        declarations: glyphs.filter((glyph) => glyph.declarationMismatch).map((glyph) => glyph.name),
        duplicates: glyphs.filter((glyph) => glyph.nearDuplicates.length > 0).map((glyph) => glyph.name)
    };
    const glyphReports = glyphs.map((glyph) => ({
        name: glyph.name,
        selectors: glyph.selectors,
        aliases: glyph.aliases,
        svg: toRepoPath(glyph.svgPath),
        png16: toRepoPath(glyph.png16Path),
        png24: toRepoPath(glyph.png24Path),
        viewBox: glyph.viewBox,
        canvas: glyph.canvas,
        coverage: round(glyph.coverage, 6),
        coveragePercent: round(glyph.coverage * 100, 2),
        coverageFlag: glyph.coverageFlag,
        bounds: {
            trimmed: glyph.bounds.trimmed,
            width: glyph.bounds.width,
            height: glyph.bounds.height,
            x: glyph.bounds.x,
            y: glyph.bounds.y,
            insetViolation: glyph.bounds.insetViolation,
            canvasMismatch: glyph.bounds.canvasMismatch,
            viewBoxMismatch: glyph.bounds.viewBoxMismatch,
            flagged: glyph.boundsFlag
        },
        strokeGlyph: glyph.strokeGlyph,
        strokeWidths: glyph.strokeWidths,
        strokeFlag: glyph.strokeFlag,
        declarationMismatch: glyph.declarationMismatch,
        alphaSignature: glyph.signature,
        nearDuplicates: glyph.nearDuplicates,
        duplicateFlag: glyph.nearDuplicates.length > 0
    }));
    const maskDeclarations = inspectMaskDeclarations(css);
    const report = {
        source: toRepoPath(SOURCE),
        generatedAt: new Date().toISOString(),
        glyphCount: glyphs.length,
        ruleBlockCount: blocks.length,
        maskImageDeclarationCount: maskDeclarations.declarationCount,
        distinctMaskPayloadCount: maskDeclarations.distinctPayloadCount,
        aliasGlyphCount: glyphs.filter((glyph) => glyph.aliases.length > 0).length,
        notes: [
            'glyphCount counts one rendered glyph per selector block (the preferred mask-image payload).',
            'distinctMaskPayloadCount also counts divergent -webkit-mask-image fallbacks, which are flagged under flags.declarations.'
        ],
        aliasGroups: glyphs.filter((glyph) => glyph.aliases.length > 0).map((glyph) => ({ name: glyph.name, aliases: glyph.aliases })),
        thresholds: {
            canvas: `${GRID_SIZE}x${GRID_SIZE}`,
            inset: INSET_PX,
            coverage: [MIN_COVERAGE, MAX_COVERAGE],
            strokeWidth: EXPECTED_STROKE_WIDTH,
            duplicateSignatureDistance: DUPLICATE_DISTANCE,
            duplicateSignatureMetric: 'differing bytes across the 16-byte 4x4 alpha signature',
            crossCheckCoverageTolerance: CROSS_CHECK_COVERAGE_TOLERANCE
        },
        crossCheck,
        sheets: {
            dark: toRepoPath(DARK_SHEET),
            light: toRepoPath(LIGHT_SHEET)
        },
        flags: flagged,
        flagCounts: {
            coverage: flagged.coverage.length,
            bounds: flagged.bounds.length,
            stroke: flagged.stroke.length,
            declarations: flagged.declarations.length,
            duplicates: flagged.duplicates.length,
            duplicatePairs: duplicatePairs.length
        },
        duplicatePairs,
        glyphs: glyphReports
    };
    return report;
}

function printSummary(glyphs, report) {
    const ranked = glyphs
        .map((glyph) => ({ glyph, ...glyphIssues(glyph) }))
        .filter((entry) => entry.issues.length > 0)
        .sort((left, right) => right.score - left.score || left.glyph.name.localeCompare(right.glyph.name));

    console.log('');
    console.log(
        `nuke-cad icon review: ${report.glyphCount} glyphs (${report.aliasGlyphCount} aliased) from ` +
            `${report.maskImageDeclarationCount} mask-image declarations (${report.distinctMaskPayloadCount} distinct payloads)`
    );
    console.log(`  source:  ${report.source}`);
    console.log(`  svgs:    ${toRepoPath(SVG_DIR)}/<name>.svg`);
    console.log(`  pngs:    ${toRepoPath(PNG16_DIR)}/<name>.png (16px), ${toRepoPath(PNG24_DIR)}/<name>.png (24px)`);
    console.log(`  sheets:  ${report.sheets.dark} (dark), ${report.sheets.light} (light)`);
    console.log(`  report:  ${toRepoPath(REPORT_FILE)}`);
    console.log(
        `  flags:   coverage ${report.flagCounts.coverage} | bounds ${report.flagCounts.bounds} | stroke ${report.flagCounts.stroke} | ` +
            `duplicates ${report.flagCounts.duplicates} (${report.flagCounts.duplicatePairs} pairs)`
    );
    if (report.flagCounts.declarations > 0) {
        console.log(`  css:     ${report.flagCounts.declarations} -webkit/standard mask-image mismatch (see report.json)`);
    }
    if (ranked.length === 0) {
        console.log('  worst:   none');
    } else {
        console.log('  worst 10 offenders:');
        for (const [index, entry] of ranked.slice(0, 10).entries()) {
            console.log(`    ${index + 1}. ${entry.glyph.name}: ${entry.issues.join('; ')}`);
        }
        if (ranked.length > 10) {
            const remaining = ranked.slice(10);
            const names = remaining.slice(0, 8).map((entry) => entry.glyph.name);
            console.log(`    ... ${remaining.length} more flagged: ${names.join(', ')}${remaining.length > names.length ? ', ...' : ''}`);
        }
    }
}

function main() {
    if (!fs.existsSync(SOURCE)) {
        fail(`source CSS not found: ${toRepoPath(SOURCE)}`);
    }
    const css = fs.readFileSync(SOURCE, 'utf8');
    const blocks = parseCss(css);
    const glyphs = collectGlyphs(blocks);
    if (glyphs.length === 0) {
        fail(`no glyphs collected from ${toRepoPath(SOURCE)}`);
    }

    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    for (const dir of [SVG_DIR, PNG16_DIR, PNG24_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    for (const glyph of glyphs) {
        renderGlyph(glyph);
    }
    const crossCheck = crossCheckRsgvConvert(glyphs[0]);
    buildSheet(glyphs, { background: '#1b1b1b', foreground: '#ececec', output: DARK_SHEET, workDir: path.join(WORK_DIR, 'dark') });
    buildSheet(glyphs, { background: '#f4f4f4', foreground: '#1e1e1e', output: LIGHT_SHEET, workDir: path.join(WORK_DIR, 'light') });
    run('oxipng', ['-o', '4', DARK_SHEET]);
    fs.rmSync(WORK_DIR, { recursive: true, force: true });

    const report = buildReport(glyphs, blocks, css, crossCheck);
    fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    printSummary(glyphs, report);
}

try {
    main();
} catch (error) {
    fail(error?.stack ?? String(error));
}
