// @ts-check
/**
 * Build-time extension selection for the NukeIDE apps.
 *
 * Theia bakes extensions into the app bundle from the app package's
 * `dependencies` at `theia build` time — there is no runtime registry.
 * This wrapper temporarily prunes unselected *optional* extensions from an
 * app's `package.json`, runs the given build command, and restores the file
 * byte-for-byte afterwards (on success, failure, or Ctrl-C).
 *
 * Selection is driven by environment variables:
 *   NUKE_EXTENSIONS=a,b          allow-list: bundle only these optional extensions
 *                                (`all` = every optional extension)
 *   NUKE_EXCLUDE_EXTENSIONS=a,b  deny-list: drop these from the default set
 *   (neither set)                default: bundle everything except DEFAULT_EXCLUDED
 *
 * `nukelab-integration` is hub-only (NukeLab deployments) and excluded by
 * default; opt in with NUKE_EXTENSIONS=all or by listing it explicitly.
 *
 * Local dependency closure is handled: picking `openmc-studio` pulls in
 * `nuke-visualizer`; excluding `nuke-visualizer` also drops `openmc-studio`.
 *
 * Usage:
 *   node scripts/with-extension-set.js <app-dir> <command>
 *   node scripts/with-extension-set.js --dry-run [app-dir]
 *
 * Adding a new extension: register it in REQUIRED or OPTIONAL below (with its
 * local extension dependencies) and in the apps' package.json dependencies.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Extensions every app needs; never pruned. */
const REQUIRED = ['nuke-core', 'nuke-essentials'];

/** Optional extensions mapped to their local extension dependencies. */
const OPTIONAL = {
    'nuke-docs': [],
    'nuke-fileinfo': [],
    'nuke-sysmon': [],
    'nuke-visualizer': [],
    'openmc-studio': ['nuke-visualizer'],
    'nukelab-integration': []
};

/** Optional extensions excluded unless explicitly selected (NUKE_EXTENSIONS). */
const DEFAULT_EXCLUDED = ['nukelab-integration'];

/** Allow-list token selecting every optional extension. */
const ALL = 'all';

const APP_DIRS = ['applications/browser', 'applications/electron'];

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseList(value) {
    return (value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/**
 * Resolve which optional extensions to exclude for one app.
 *
 * @param {string[]} availableOptional optional extensions present in the app's dependencies
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ excluded: string[], notes: string[] }}
 */
function computeExclusion(availableOptional, env) {
    const known = Object.keys(OPTIONAL);
    const notes = [];
    const allowList = parseList(env.NUKE_EXTENSIONS);
    const denyList = parseList(env.NUKE_EXCLUDE_EXTENSIONS);

    for (const name of [...allowList, ...denyList]) {
        if (name === ALL) {
            continue;
        }
        if (!known.includes(name)) {
            throw new Error(`Unknown extension "${name}". Known optional extensions: ${known.join(', ')}`);
        }
        if (!availableOptional.includes(name)) {
            notes.push(`"${name}" is not a dependency of this app; ignoring`);
        }
    }

    if (allowList.length > 0) {
        const included = new Set(
            allowList.includes(ALL) ? availableOptional : allowList.filter((name) => availableOptional.includes(name))
        );
        // Pull in local dependency closure of the selected extensions.
        const queue = [...included];
        while (queue.length > 0) {
            const name = /** @type {string} */ (queue.pop());
            for (const dep of OPTIONAL[name]) {
                if (availableOptional.includes(dep) && !included.has(dep)) {
                    included.add(dep);
                    notes.push(`auto-including "${dep}" (required by "${name}")`);
                    queue.push(dep);
                }
            }
        }
        return { excluded: availableOptional.filter((name) => !included.has(name)), notes };
    }

    const excluded = new Set(DEFAULT_EXCLUDED.filter((name) => availableOptional.includes(name)));
    for (const name of excluded) {
        notes.push(`"${name}" is excluded by default; pass NUKE_EXTENSIONS=${ALL} (or list it) to opt in`);
    }
    for (const name of denyList.includes(ALL) ? availableOptional : denyList) {
        if (!availableOptional.includes(name)) {
            continue; // already noted above
        }
        if (excluded.has(name)) {
            notes.push(`"${name}" is already excluded by default`);
        } else {
            excluded.add(name);
        }
    }
    // Drop extensions whose local dependencies were excluded.
    let changed = true;
    while (changed) {
        changed = false;
        for (const name of availableOptional) {
            if (!excluded.has(name) && OPTIONAL[name].some((dep) => excluded.has(dep))) {
                excluded.add(name);
                notes.push(`also excluding "${name}" (its dependency was excluded)`);
                changed = true;
            }
        }
    }
    return { excluded: [...excluded], notes };
}

/**
 * @param {string} appDir
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ excluded: string[], notes: string[], availableOptional: string[] }}
 */
function planForApp(appDir, env) {
    const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf-8'));
    const deps = pkg.dependencies || {};
    const availableOptional = Object.keys(OPTIONAL).filter((name) => name in deps);
    const { excluded, notes } = computeExclusion(availableOptional, env);
    return { excluded, notes, availableOptional };
}

/**
 * @param {string} appDir
 */
function dryRun(appDir) {
    const { excluded, notes, availableOptional } = planForApp(appDir, process.env);
    const included = availableOptional.filter((name) => !excluded.includes(name));
    console.log(`\n${appDir}:`);
    console.log(`  required: ${REQUIRED.join(', ')}`);
    console.log(`  included: ${included.length > 0 ? included.join(', ') : '(none)'}`);
    console.log(`  excluded: ${excluded.length > 0 ? excluded.join(', ') : '(none)'}`);
    for (const note of notes) {
        console.log(`  note: ${note}`);
    }
}

/**
 * @param {string} command shell command to run
 * @param {() => void} restore called on every exit path before exiting
 * @returns {Promise<number>} child exit code
 */
function runCommand(command, restore) {
    return new Promise((resolve) => {
        const child = spawn(command, { shell: true, stdio: 'inherit' });
        const forward = /** @param {NodeJS.Signals} signal */ (signal) => {
            child.kill(signal);
        };
        process.on('SIGINT', forward);
        process.on('SIGTERM', forward);
        child.on('exit', (code, signal) => {
            process.removeListener('SIGINT', forward);
            process.removeListener('SIGTERM', forward);
            restore();
            if (signal) {
                // Restore the default handler and re-raise so exit codes stay conventional.
                process.kill(process.pid, signal);
                return;
            }
            resolve(code === null ? 1 : code);
        });
    });
}

async function main() {
    const args = process.argv.slice(2);
    const dryRunFlag = args.includes('--dry-run');
    const positional = args.filter((arg) => arg !== '--dry-run');

    if (dryRunFlag) {
        const appDirs = positional.length > 0 ? [positional[0]] : APP_DIRS;
        for (const appDir of appDirs) {
            dryRun(appDir);
        }
        return;
    }

    const [appDir, ...commandParts] = positional;
    const command = commandParts.join(' ').trim();
    if (!appDir || !command) {
        console.error('Usage: node scripts/with-extension-set.js <app-dir> [--dry-run] <command>');
        console.error('       node scripts/with-extension-set.js --dry-run [app-dir]');
        process.exit(1);
    }

    const pkgPath = path.join(appDir, 'package.json');
    const { excluded, notes } = planForApp(appDir, process.env);
    for (const note of notes) {
        console.log(`[with-extension-set] ${note}`);
    }
    if (excluded.length === 0) {
        console.log('[with-extension-set] all extensions selected; building unmodified manifest');
        process.exitCode = await runCommand(command, () => undefined);
        return;
    }

    console.log(`[with-extension-set] excluding from this build: ${excluded.join(', ')}`);
    const original = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(original);
    for (const name of excluded) {
        delete pkg.dependencies[name];
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4) + '\n', 'utf-8');

    let restored = false;
    const restore = () => {
        if (!restored) {
            restored = true;
            fs.writeFileSync(pkgPath, original, 'utf-8');
        }
    };
    process.on('exit', restore);
    process.exitCode = await runCommand(command, restore);
    console.log(`[with-extension-set] restored ${pkgPath}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[with-extension-set] ${error.message}`);
        process.exit(1);
    });
}

module.exports = { REQUIRED, OPTIONAL, DEFAULT_EXCLUDED, ALL, computeExclusion, parseList };
