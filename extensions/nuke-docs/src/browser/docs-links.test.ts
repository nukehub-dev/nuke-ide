import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDocAsset, resolveDocPath, splitDocTarget } from './docs-links';

describe('docs link resolution', () => {
    it('resolves sibling and parent documentation pages', () => {
        expect(resolveDocPath('/nuke-core/user/index.md', '../dev/index.md')).toBe('/nuke-core/dev/index.md');
        expect(resolveDocPath('/openmc-studio/user/geometry.md', './dagmc-editor.md')).toBe('/openmc-studio/user/dagmc-editor.md');
        expect(resolveDocPath('/nuke-cad/user/getting-started.md', '../dev/architecture.md')).toBe('/nuke-cad/dev/architecture.md');
    });

    it('maps portable extension docs paths onto served routes', () => {
        expect(resolveDocPath('/nuke-core/user/index.md', '../../openmc-studio/docs/user/getting-started.md')).toBe(
            '/openmc-studio/user/getting-started.md'
        );
        expect(resolveDocPath('/openmc-studio/user/geometry.md', '../../../nuke-visualizer/docs/user/base-visualizer.md')).toBe(
            '/nuke-visualizer/user/base-visualizer.md'
        );
        expect(resolveDocPath('/nuke-cad/dev/index.md', '../../../../docs/installation.md')).toBe('/product/installation.md');
        expect(resolveDocPath('/product/extensions.md', '../extensions/nuke-core/docs/user/getting-started.md')).toBe(
            '/nuke-core/user/getting-started.md'
        );
        expect(resolveDocPath('/product/index.md', '/nuke-cad/dev/architecture')).toBe('/nuke-cad/dev/architecture.md');
    });

    it('preserves fragments and does not append .md after them', () => {
        expect(resolveDocPath('/nuke-visualizer/user/index.md', 'openmc/tally-visualization.md#overlay-tally-on-geometry')).toBe(
            '/nuke-visualizer/user/openmc/tally-visualization.md#overlay-tally-on-geometry'
        );
    });

    it('adds .md to extension-less page links and normalizes README pages', () => {
        expect(resolveDocPath('/product/getting-started.md', './installation')).toBe('/product/installation.md');
        expect(resolveDocPath('/product/index.md', '/nuke-core/README.md')).toBe('/nuke-core/index.md');
    });

    it('resolves assets without rewriting their extension', () => {
        expect(resolveDocAsset('/nuke-cad/user/gui-modeler.md', './images/ribbon.png')).toBe('/nuke-cad/user/images/ribbon.png');
        expect(resolveDocAsset('/product/index.md', 'images/architecture-overview.svg')).toBe('/product/images/architecture-overview.svg');
        expect(resolveDocAsset('/product/index.md', 'https://example.com/a.png')).toBe('https://example.com/a.png');
    });

    it('splits targets without treating fragments as file names', () => {
        expect(splitDocTarget('/nuke-core/user/index.md#status-bar')).toEqual({
            path: '/nuke-core/user/index.md',
            fragment: '#status-bar'
        });
        expect(splitDocTarget('/nuke-core/user/index.md')).toEqual({
            path: '/nuke-core/user/index.md',
            fragment: ''
        });
    });
});

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PRODUCT_ROOT = path.join(REPO_ROOT, 'docs');

/** Map a markdown file on disk to the route the docs widget serves. */
function servedPath(file: string): string | undefined {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    if (relative.startsWith('docs/')) {
        return '/product/' + relative.slice('docs/'.length);
    }
    const match = /^extensions\/([^/]+)\/docs\/(.+)$/.exec(relative);
    return match ? `/${match[1]}/${match[2]}` : undefined;
}

/** Map a served route back to its markdown or asset file. */
function diskPath(served: string): string | undefined {
    if (served.startsWith('/product/')) {
        return path.join(PRODUCT_ROOT, served.slice('/product/'.length));
    }
    const match = /^\/([^/]+)\/(.+)$/.exec(served);
    if (!match) {
        return undefined;
    }
    return path.join(REPO_ROOT, 'extensions', match[1], 'docs', match[2]);
}

/** Markdown files under a docs root, excluding generated trees. */
function markdownFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') {
            return [];
        }
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? markdownFiles(full) : entry.name.endsWith('.md') ? [full] : [];
    });
}

/** Product and extension Markdown pages rendered on GitHub and in the docs widget. */
function shippedMarkdownFiles(): string[] {
    const extensionsRoot = path.join(REPO_ROOT, 'extensions');
    const extensionDocs = fs
        .readdirSync(extensionsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => markdownFiles(path.join(extensionsRoot, entry.name, 'docs')));
    return [...markdownFiles(PRODUCT_ROOT), ...extensionDocs];
}

describe('shipped documentation links', () => {
    it('every relative link and image points at a shipped file', () => {
        const files = shippedMarkdownFiles();
        const broken: string[] = [];
        for (const file of files) {
            const served = servedPath(file);
            if (!served) {
                continue;
            }
            // Ignore links written as inline examples.
            const text = fs
                .readFileSync(file, 'utf-8')
                .replace(/```[\s\S]*?```/g, '')
                .replace(/`[^`\n]*`/g, '');
            for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
                const target = match[1].trim().replace(/^<|>$/g, '');
                if (target.startsWith('http') || target.startsWith('#') || target.startsWith('mailto:')) {
                    continue;
                }
                const isImage = match[0].startsWith('!');
                const resolved = isImage ? resolveDocAsset(served, target) : resolveDocPath(served, target);
                const resolvedPath = splitDocTarget(resolved).path;
                const onDisk = diskPath(resolvedPath);
                if (!onDisk) {
                    continue;
                }
                const readmeFallback = onDisk.endsWith('/index.md') ? onDisk.replace(/\/index\.md$/, '/README.md') : '';
                if (
                    !fs.existsSync(onDisk) &&
                    !(!path.extname(onDisk) && fs.existsSync(onDisk + '.md')) &&
                    !(readmeFallback && fs.existsSync(readmeFallback))
                ) {
                    broken.push(`${path.relative(REPO_ROOT, file)} -> ${target}`);
                }
            }
        }
        expect(broken).toEqual([]);
    });

    it('avoids root-absolute paths that break GitHub rendering', () => {
        const absolute: string[] = [];
        for (const file of shippedMarkdownFiles()) {
            const text = fs
                .readFileSync(file, 'utf-8')
                .replace(/```[\s\S]*?```/g, '')
                .replace(/`[^`\n]*`/g, '');
            for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
                const target = match[1].trim().replace(/^<|>$/g, '');
                if (target.startsWith('/') && !target.startsWith('//')) {
                    absolute.push(`${path.relative(REPO_ROOT, file)} -> ${target}`);
                }
            }
        }
        expect(absolute).toEqual([]);
    });
});
