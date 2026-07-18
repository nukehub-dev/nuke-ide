import { injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node';
import * as express from '@theia/core/shared/express';
import * as fs from 'fs';
import * as path from 'path';

export interface DocsNavItem {
    title: string;
    path: string;
    children?: DocsNavItem[];
}

export interface SearchResult {
    title: string;
    path: string;
    snippet: string;
}

@injectable()
export class DocsServerContribution implements BackendApplicationContribution {
    protected searchIndex: SearchResult[] = [];

    configure(app: express.Application): void {
        const appProjectPath = process.env.THEIA_APP_PROJECT_PATH || process.cwd();
        const devRoot = path.resolve(appProjectPath, '..', '..');

        const findDocsDir = (name: string): string | undefined => {
            const candidates = [
                path.resolve(appProjectPath, 'extensions', name, 'docs'),
                path.resolve(appProjectPath, 'node_modules', name, 'docs'),
                path.resolve(devRoot, 'extensions', name, 'docs')
            ];
            return candidates.find((c) => fs.existsSync(c));
        };

        const productDocs =
            [path.resolve(appProjectPath, 'docs'), path.resolve(devRoot, 'docs')].find((c) => fs.existsSync(c)) ||
            path.resolve(devRoot, 'docs');

        const rawPaths: Record<string, string> = {
            '/product': productDocs,
            '/nuke-core': findDocsDir('nuke-core') || path.resolve(devRoot, 'extensions', 'nuke-core', 'docs'),
            '/nuke-visualizer': findDocsDir('nuke-visualizer') || path.resolve(devRoot, 'extensions', 'nuke-visualizer', 'docs'),
            '/openmc-studio': findDocsDir('openmc-studio') || path.resolve(devRoot, 'extensions', 'openmc-studio', 'docs')
        };

        // Build search index at startup
        this.searchIndex = this.buildSearchIndex(rawPaths);

        // Build search index at startup
        this.searchIndex = this.buildSearchIndex(rawPaths);

        app.get('/docs-api/nav', (_req, res) => {
            try {
                res.json(this.buildNav(rawPaths));
            } catch (e) {
                res.status(500).json({ error: String(e) });
            }
        });

        app.get('/docs-api/content', (req, res) => {
            const file = this.resolveDocPath(String(req.query.path || ''), rawPaths);
            if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                return res.status(404).json({ error: 'Not found' });
            }
            res.type('text/markdown').sendFile(file);
        });

        app.get('/docs-api/file', (req, res) => {
            const file = this.resolveDocPath(String(req.query.path || ''), rawPaths);
            if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                return res.status(404).json({ error: 'Not found' });
            }
            res.sendFile(file);
        });

        app.get('/docs-api/search', (req, res) => {
            const q = String(req.query.q || '')
                .toLowerCase()
                .trim();
            if (!q) return res.json([]);
            const results = this.searchIndex
                .filter((item) => item.title.toLowerCase().includes(q) || item.snippet.toLowerCase().includes(q))
                .slice(0, 20);
            res.json(results);
        });
    }

    protected buildSearchIndex(rawPaths: Record<string, string>): SearchResult[] {
        const results: SearchResult[] = [];
        for (const [prefix, dir] of Object.entries(rawPaths)) {
            if (!fs.existsSync(dir)) continue;
            this.indexDir(dir, prefix, results);
        }
        return results;
    }

    protected indexDir(dir: string, urlPrefix: string, results: SearchResult[]): void {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.vitepress' || entry.name === 'public') continue;
            const entryPath = path.join(dir, entry.name);
            const urlPath = urlPrefix + '/' + entry.name;
            if (entry.isDirectory()) {
                this.indexDir(entryPath, urlPath, results);
            } else if (entry.name.endsWith('.md')) {
                const content = fs.readFileSync(entryPath, 'utf-8');
                const title = this.extractTitle(content) || entry.name.replace(/\.md$/, '');
                const text = content.replace(/^---\s*\n[\s\S]*?^---\s*\n/m, '').replace(/[#*`\[\]\(\)\|>_-]/g, ' ');
                const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 240);
                results.push({ title, path: urlPath, snippet });
            }
        }
    }

    protected resolveDocPath(requestPath: string, rawPaths: Record<string, string>): string | undefined {
        const normalized = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.(\/|\\|$))+/, '');
        for (const [prefix, dir] of Object.entries(rawPaths)) {
            if (normalized.startsWith(prefix + '/')) {
                const relative = normalized.slice(prefix.length + 1);
                const filePath = path.join(dir, relative);
                if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
                    return filePath;
                }
                // Fallback: index.md → README.md
                if (relative.endsWith('index.md')) {
                    const readmePath = path.join(dir, relative.replace(/index\.md$/, 'README.md'));
                    if (fs.existsSync(readmePath)) {
                        return readmePath;
                    }
                }
                // Fallback: README.md → index.md
                if (relative.endsWith('README.md')) {
                    const indexPath = path.join(dir, relative.replace(/README\.md$/, 'index.md'));
                    if (fs.existsSync(indexPath)) {
                        return indexPath;
                    }
                }
                return filePath;
            }
        }
        return undefined;
    }

    protected buildNav(rawPaths: Record<string, string>): DocsNavItem[] {
        const result: DocsNavItem[] = [];
        const skipDirs = new Set(['nuke-core', 'nuke-visualizer', 'openmc-studio', '.vitepress', 'public']);

        for (const [prefix, dir] of Object.entries(rawPaths)) {
            if (!fs.existsSync(dir)) continue;
            const name = prefix === '/product' ? 'NukeIDE' : path.basename(dir);
            const rootItem = this.scanDir(dir, prefix, name, prefix === '/product' ? skipDirs : undefined);
            if (rootItem) result.push(rootItem);
        }

        return result;
    }

    protected scanDir(dir: string, urlPrefix: string, fallbackTitle: string, skipDirs?: Set<string>): DocsNavItem | undefined {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const children: DocsNavItem[] = [];

        for (const entry of entries) {
            if (skipDirs?.has(entry.name)) continue;
            const entryPath = path.join(dir, entry.name);
            const urlPath = urlPrefix + '/' + entry.name;

            if (entry.isDirectory()) {
                const child = this.scanDir(entryPath, urlPath, entry.name, skipDirs);
                if (child) children.push(child);
            } else if (entry.name.endsWith('.md')) {
                if (entry.name === 'index.md' || entry.name === 'README.md') continue;
                const title = this.extractTitleFromFile(entryPath) || entry.name.replace(/\.md$/, '');
                children.push({ title, path: urlPath });
            }
        }

        children.sort((a, b) => {
            const aIsDir = a.children ? 1 : 0;
            const bIsDir = b.children ? 1 : 0;
            if (aIsDir !== bIsDir) return bIsDir - aIsDir;
            return a.title.localeCompare(b.title);
        });

        const rootMd = path.join(dir, 'index.md');
        const rootReadme = path.join(dir, 'README.md');
        const rootFile = fs.existsSync(rootMd) ? rootMd : fs.existsSync(rootReadme) ? rootReadme : undefined;
        const title = rootFile ? this.extractTitleFromFile(rootFile) || fallbackTitle : fallbackTitle;
        const rootPath = rootFile ? urlPrefix + '/' + path.basename(rootFile) : children[0]?.path;

        if (children.length === 0 && !rootFile) return undefined;

        return {
            title,
            path: rootPath || urlPrefix,
            children: children.length > 0 ? children : undefined
        };
    }

    protected extractTitleFromFile(filePath: string): string | undefined {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return this.extractTitle(content);
        } catch {
            return undefined;
        }
    }

    protected extractTitle(content: string): string | undefined {
        const match = content.match(/^#\s+(.+)$/m);
        return match ? match[1].trim() : undefined;
    }
}
