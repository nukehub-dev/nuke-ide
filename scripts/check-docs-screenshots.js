#!/usr/bin/env node
/**
 * Validate product-docs screenshots against `docs/screenshots.json`.
 *
 * The manifest is the source of truth for every screenshot shown in the docs.
 * This checker fails when the manifest is malformed, an image is missing or not
 * a valid PNG, a manifest image is never referenced by a Markdown page, a page
 * references an undeclared PNG, or a PNG under a docs tree is undeclared.
 *
 * Usage:
 *   node scripts/check-docs-screenshots.js
 *   node scripts/check-docs-screenshots.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT_DIR, 'docs', 'screenshots.json');
const MANIFEST_LABEL = 'docs/screenshots.json';
const DOCS_DIR = path.join(ROOT_DIR, 'docs');
const EXTENSIONS_DIR = path.join(ROOT_DIR, 'extensions');
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 200;
const INDEXED_COLOR_TYPE = 3;
const SKIP_DIRS = new Set(['node_modules', 'lib', '.git']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_IMAGE_PATTERN = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/** @param {string} file */
function repoPath(file) {
    return path.relative(ROOT_DIR, file).split(path.sep).join('/');
}

/** @param {string} file */
function compareKey(file) {
    const normalized = path.posix.normalize(file);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** True when a `path.relative` result leaves the repository root. */
function isOutsideRoot(relative) {
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** Recursively collect files under `dir`, skipping generated trees. */
function walkFiles(dir, predicate) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkFiles(full, predicate));
        } else if (entry.isFile() && predicate(entry.name)) {
            files.push(full);
        }
    }
    return files;
}

/** Extension name -> `extensions/<name>/docs` for every extension that ships docs. */
function extensionDocsRoots() {
    const roots = new Map();
    if (!fs.existsSync(EXTENSIONS_DIR)) {
        return roots;
    }
    for (const entry of fs.readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }
        const docs = path.join(EXTENSIONS_DIR, entry.name, 'docs');
        if (fs.existsSync(docs) && fs.statSync(docs).isDirectory()) {
            roots.set(entry.name, docs);
        }
    }
    return roots;
}

/** Remove fenced code blocks and inline code spans so examples are ignored. */
function stripCode(text) {
    return text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm, '').replace(/(`+)([^`\n]*?)\1/g, '');
}

/** Read width/height/color type from the PNG signature and IHDR chunk. */
function readPngSize(buffer) {
    if (buffer.length < 26 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return undefined;
    }
    const chunkLength = buffer.readUInt32BE(8);
    const chunkType = buffer.toString('latin1', 12, 16);
    if (chunkLength !== 13 || chunkType !== 'IHDR') {
        return undefined;
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
}

/** Read only the bytes needed for the PNG header check. */
function readPngHeader(file) {
    const buffer = Buffer.alloc(26);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
        fs.closeSync(fd);
    }
    return buffer;
}

/** Map a served docs route (`/product/...`, `/<extension>/...`) to its file. */
function servedRouteToFile(route, docsRoots) {
    if (route === '/product' || route.startsWith('/product/')) {
        return path.join(DOCS_DIR, route.slice('/product'.length).replace(/^\//, ''));
    }
    const match = /^\/([^/]+)\/(.+)$/.exec(route);
    if (!match) {
        return undefined;
    }
    const docsRoot = docsRoots.get(match[1]);
    return docsRoot ? path.join(docsRoot, match[2]) : undefined;
}

/** Resolve an image target to an absolute path, or report why it cannot be resolved. */
function resolveImageTarget(markdownFile, target, docsRoots) {
    if (target.startsWith('/')) {
        const resolved = servedRouteToFile(target, docsRoots);
        return resolved ? { file: resolved } : { problem: `unresolved served route: ${target}` };
    }
    return { file: path.resolve(path.dirname(markdownFile), target) };
}

/** Validate and register one manifest entry. */
function validateEntry(entry, index, declared, ids, problems) {
    const label = `${MANIFEST_LABEL}: screenshots[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.add(`${label} must be an object`);
        return;
    }

    let id;
    if (typeof entry.id !== 'string' || entry.id.trim() === '') {
        problems.add(`${label} is missing a non-empty "id"`);
    } else {
        id = entry.id;
        if (ids.has(id)) {
            problems.add(`${label} duplicates id "${id}"`);
        }
        ids.add(id);
    }

    if (typeof entry.file !== 'string' || entry.file.trim() === '') {
        problems.add(`${label} is missing a non-empty "file"`);
        return;
    }
    const file = entry.file;
    if (file.includes('\\')) {
        problems.add(`${label} file must use forward slashes: ${file}`);
        return;
    }
    if (!file.endsWith('.png')) {
        problems.add(`${label} file must end in .png: ${file}`);
        return;
    }
    if (path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file)) {
        problems.add(`${label} file must be repository-relative: ${file}`);
        return;
    }
    const normalized = path.posix.normalize(file);
    if (normalized !== file || normalized === '..' || normalized.startsWith('../') || normalized.split('/').includes('..')) {
        problems.add(`${label} file must stay inside the repository: ${file}`);
        return;
    }
    const absolute = path.resolve(ROOT_DIR, file);
    const relativeBack = path.relative(ROOT_DIR, absolute);
    if (!relativeBack || isOutsideRoot(relativeBack)) {
        problems.add(`${label} file must stay inside the repository: ${file}`);
        return;
    }

    const key = compareKey(file);
    if (declared.has(key)) {
        problems.add(`${label} duplicates file "${file}"`);
        return;
    }

    if (!fs.existsSync(absolute)) {
        problems.add(`${label} file does not exist: ${file}`);
        declared.set(key, { file, id });
        return;
    }
    if (!fs.statSync(absolute).isFile()) {
        problems.add(`${label} path is not a file: ${file}`);
        declared.set(key, { file, id });
        return;
    }
    declared.set(key, { file, id });

    const size = fs.statSync(absolute).size;
    if (size > MAX_IMAGE_BYTES) {
        problems.add(`${label} is ${(size / (1024 * 1024)).toFixed(1)} MB; maximum is 2 MB: ${file}`);
    }
    const dimensions = readPngSize(readPngHeader(absolute));
    if (!dimensions) {
        problems.add(`${label} is not a valid PNG: ${file}`);
        return;
    }
    if (dimensions.width < MIN_WIDTH || dimensions.height < MIN_HEIGHT) {
        problems.add(`${label} is ${dimensions.width}x${dimensions.height}; minimum is ${MIN_WIDTH}x${MIN_HEIGHT}: ${file}`);
    }
    if (dimensions.colorType !== INDEXED_COLOR_TYPE) {
        problems.add(`${label} is not an indexed PNG (color type ${dimensions.colorType}); run yarn docs:screenshots`);
    }
}

/** Load and validate the manifest. Returns the declared files, or undefined on a fatal error. */
function loadManifest(problems) {
    if (!fs.existsSync(MANIFEST_PATH)) {
        problems.add(`${MANIFEST_LABEL}: file does not exist`);
        return undefined;
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    } catch (error) {
        problems.add(`${MANIFEST_LABEL}: invalid JSON: ${error.message}`);
        return undefined;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        problems.add(`${MANIFEST_LABEL}: expected a JSON object`);
        return undefined;
    }
    if (manifest.version !== 1) {
        problems.add(`${MANIFEST_LABEL}: expected "version": 1`);
    }
    if (!Array.isArray(manifest.screenshots) || manifest.screenshots.length === 0) {
        problems.add(`${MANIFEST_LABEL}: "screenshots" must be a non-empty array`);
        return undefined;
    }

    const declared = new Map();
    const ids = new Set();
    manifest.screenshots.forEach((entry, index) => validateEntry(entry, index, declared, ids, problems));
    return declared;
}

/** Collect PNG references from every Markdown page under the docs trees. */
function scanMarkdown(docsRoots, declared, problems) {
    const markdownFiles = [...walkFiles(DOCS_DIR, (name) => name.endsWith('.md'))];
    for (const docsRoot of docsRoots.values()) {
        markdownFiles.push(...walkFiles(docsRoot, (name) => name.endsWith('.md')));
    }
    // The repository README links the workbench hero; validate it too.
    const rootReadme = path.join(ROOT_DIR, 'README.md');
    if (fs.existsSync(rootReadme)) {
        markdownFiles.push(rootReadme);
    }

    const referenced = new Set();
    let referenceCount = 0;
    for (const markdownFile of markdownFiles) {
        const text = stripCode(fs.readFileSync(markdownFile, 'utf-8'));
        const targets = [];
        for (const match of text.matchAll(MARKDOWN_IMAGE_PATTERN)) {
            targets.push(match[1].trim().replace(/^<|>$/g, ''));
        }
        for (const match of text.matchAll(HTML_IMAGE_PATTERN)) {
            targets.push(match[1].trim());
        }

        for (const target of targets) {
            if (!target || target.startsWith('#') || target.startsWith('//') || /^(https?:|data:|blob:|mailto:)/i.test(target)) {
                continue;
            }
            const targetPath = target.split('#')[0].split('?')[0];
            if (!targetPath.toLowerCase().endsWith('.png')) {
                continue;
            }
            referenceCount++;

            const resolved = resolveImageTarget(markdownFile, targetPath, docsRoots);
            if (resolved.problem) {
                problems.add(`${repoPath(markdownFile)}: ${resolved.problem}`);
                continue;
            }
            const relative = path.relative(ROOT_DIR, resolved.file);
            if (isOutsideRoot(relative)) {
                problems.add(`${repoPath(markdownFile)}: image resolves outside the repository: ${target}`);
                continue;
            }
            const file = relative.split(path.sep).join('/');
            if (!fs.existsSync(resolved.file)) {
                problems.add(`${repoPath(markdownFile)}: image does not exist: ${target}`);
            }
            if (!declared.has(compareKey(file))) {
                problems.add(`${repoPath(markdownFile)}: image is not declared in ${MANIFEST_LABEL}: ${target}`);
            }
            referenced.add(compareKey(file));
        }
    }
    return { referenced, referenceCount, pageCount: markdownFiles.length };
}

/** Verify every manifest image is referenced and every docs PNG is declared. */
function checkCoverage(declared, scan, docsRoots, problems) {
    for (const { file, id } of declared.values()) {
        if (!scan.referenced.has(compareKey(file))) {
            problems.add(`${MANIFEST_LABEL}: screenshot "${id}" is never referenced by a Markdown page: ${file}`);
        }
    }

    const pngFiles = [...walkFiles(DOCS_DIR, (name) => name.endsWith('.png'))];
    for (const docsRoot of docsRoots.values()) {
        pngFiles.push(...walkFiles(docsRoot, (name) => name.endsWith('.png')));
    }
    for (const pngFile of pngFiles) {
        const file = repoPath(pngFile);
        if (!declared.has(compareKey(file))) {
            problems.add(`${file}: PNG is not declared in ${MANIFEST_LABEL}`);
        }
    }
}

function printUsage() {
    console.log('Usage: node scripts/check-docs-screenshots.js');
    console.log('');
    console.log('Validates docs/screenshots.json, every declared PNG, and every PNG reference');
    console.log('in Markdown under docs/ and extensions/*/docs/. Exits nonzero on any problem.');
}

/** Print problems in a stable order. */
function printProblems(problems) {
    for (const problem of [...problems].sort()) {
        console.error(`[docs-screenshots] ${problem}`);
    }
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

    /** @type {Set<string>} */
    const problems = new Set();
    const docsRoots = extensionDocsRoots();
    const declared = loadManifest(problems);
    if (!declared) {
        printProblems(problems);
        process.exitCode = 1;
        return;
    }

    const scan = scanMarkdown(docsRoots, declared, problems);
    checkCoverage(declared, scan, docsRoots, problems);

    printProblems(problems);
    if (problems.size > 0) {
        console.error(`[docs-screenshots] ${problems.size} problem(s); see docs/README.md for the screenshot workflow.`);
        process.exitCode = 1;
        return;
    }
    console.log(
        `[docs-screenshots] OK: ${declared.size} screenshots declared and referenced across ` +
            `${scan.pageCount} Markdown pages (${scan.referenceCount} image references).`
    );
}

if (require.main === module) {
    main();
}
