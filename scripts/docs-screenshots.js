#!/usr/bin/env node
/**
 * Regenerate every product-docs screenshot, then validate the result.
 *
 * Steps:
 *   1. Build the browser app (`yarn build:browser`) unless skipped.
 *   2. Require `applications/browser/lib/frontend`.
 *   3. Run the gated Playwright capture spec.
 *   4. Quantize fresh captures to indexed PNGs.
 *   5. Run `scripts/check-docs-screenshots.js`.
 *
 * Usage:
 *   yarn docs:screenshots
 *   yarn docs:screenshots --skip-build
 *   NUKE_DOCS_SCREENSHOTS_SKIP_BUILD=1 yarn docs:screenshots
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'applications', 'browser', 'lib', 'frontend');
const OPTIMIZER_SCRIPT = path.join('scripts', 'optimize-docs-screenshots.js');
const CHECKER_SCRIPT = path.join('scripts', 'check-docs-screenshots.js');
const CAPTURE_SPEC = 'tests/ui/docs-screenshots.spec.ts';
const IS_WINDOWS = process.platform === 'win32';

function tool(name) {
    return IS_WINDOWS ? `${name}.cmd` : name;
}

function printUsage() {
    console.log('Usage: node scripts/docs-screenshots.js [--skip-build]');
    console.log('');
    console.log('Builds the browser app (unless --skip-build), captures every screenshot declared');
    console.log('in docs/screenshots.json with Playwright, and runs the manifest checker.');
    console.log('Set NUKE_DOCS_SCREENSHOTS_SKIP_BUILD=1 instead of --skip-build to reuse a build.');
}

/**
 * Run one step with inherited stdio. Returns the child exit status.
 * `.cmd` wrappers need a shell on Windows; everything else runs directly.
 */
function run(label, command, args, options = {}) {
    console.log(`[docs:screenshots] ${label}`);
    const result = spawnSync(command, args, {
        cwd: ROOT_DIR,
        stdio: 'inherit',
        env: { ...process.env, ...options.env },
        shell: options.shell === true
    });
    if (result.error) {
        console.error(`[docs:screenshots] ${result.error.message}`);
        return 1;
    }
    if (result.signal) {
        console.error(`[docs:screenshots] stopped by ${result.signal}`);
        return 1;
    }
    return result.status === null ? 1 : result.status;
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
        printUsage();
        return;
    }
    const unknown = args.filter((arg) => arg !== '--skip-build');
    if (unknown.length > 0) {
        console.error(`[docs:screenshots] Unknown argument: ${unknown[0]}`);
        printUsage();
        process.exitCode = 2;
        return;
    }

    const skipBuild = args.includes('--skip-build') || process.env.NUKE_DOCS_SCREENSHOTS_SKIP_BUILD === '1';

    if (skipBuild) {
        console.log('[docs:screenshots] skipping the browser build (--skip-build)');
    } else {
        const buildStatus = run('building the browser app (yarn build:browser)', tool('yarn'), ['build:browser'], {
            shell: IS_WINDOWS
        });
        if (buildStatus !== 0) {
            process.exitCode = buildStatus;
            return;
        }
    }

    if (!fs.existsSync(FRONTEND_DIR) || !fs.statSync(FRONTEND_DIR).isDirectory()) {
        console.error(`[docs:screenshots] Missing browser build: ${path.relative(ROOT_DIR, FRONTEND_DIR)}`);
        console.error('[docs:screenshots] Run `yarn build:browser` first, or drop --skip-build.');
        process.exitCode = 1;
        return;
    }

    const captureStatus = run(
        `capturing screenshots (npx playwright test ${CAPTURE_SPEC})`,
        tool('npx'),
        ['playwright', 'test', CAPTURE_SPEC],
        {
            shell: IS_WINDOWS,
            env: { NUKE_DOCS_SCREENSHOTS: '1' }
        }
    );
    if (captureStatus !== 0) {
        process.exitCode = captureStatus;
        return;
    }

    const optimizeStatus = run('optimizing screenshots to indexed PNGs', process.execPath, [OPTIMIZER_SCRIPT]);
    if (optimizeStatus !== 0) {
        process.exitCode = optimizeStatus;
        return;
    }

    const checkStatus = run('validating the manifest and docs references', process.execPath, [CHECKER_SCRIPT]);
    process.exitCode = checkStatus;
}

if (require.main === module) {
    main();
}
