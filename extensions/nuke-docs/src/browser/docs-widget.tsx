import * as React from 'react';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message, codicon } from '@theia/core/lib/browser';
import { Endpoint } from '@theia/core/lib/browser/endpoint';
import MarkdownIt from 'markdown-it';
import { SimpleLoadingSpinner, ErrorDisplay, LoadingAnimations } from 'nuke-essentials/lib/theme/browser/components/loading-spinner';
import { DocsSidebar } from './docs-sidebar';
import { DocsToc, TocItem } from './docs-toc';

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

interface DocsWidgetState {
    nav: DocsNavItem[];
    currentPath: string;
    content: string;
    expanded: Set<string>;
    loading: boolean;
    error: string | null;
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    tocWidth: number;
    searchQuery: string;
    searchResults: SearchResult[];
    searchOpen: boolean;
    searchLoading: boolean;
    tocItems: TocItem[];
    activeTocId: string | null;
    tocCollapsed: boolean;
}

export class DocsWidget extends ReactWidget {
    static readonly ID = 'nuke-docs-widget';
    static readonly LABEL = 'NukeIDE Documentation';
    static readonly MIN_SIDEBAR_WIDTH = 180;
    static readonly MAX_SIDEBAR_WIDTH = 500;
    static readonly DEFAULT_SIDEBAR_WIDTH = 280;
    static readonly MIN_TOC_WIDTH = 150;
    static readonly MAX_TOC_WIDTH = 350;
    static readonly DEFAULT_TOC_WIDTH = 220;

    protected md: MarkdownIt;
    protected readonly state: DocsWidgetState;
    protected searchDebounce: ReturnType<typeof setTimeout> | undefined;
    protected contentRef = React.createRef<HTMLDivElement>();
    protected containerRef = React.createRef<HTMLDivElement>();
    protected tocItemsBuffer: TocItem[] = [];

    constructor() {
        super();
        this.id = DocsWidget.ID;
        this.title.label = DocsWidget.LABEL;
        this.title.caption = '';
        this.title.closable = true;
        this.state = {
            nav: [],
            currentPath: '/product/index.md',
            content: '',
            expanded: new Set(['/product', '/nuke-core', '/nuke-visualizer', '/openmc-studio']),
            loading: false,
            error: null,
            sidebarCollapsed: false,
            sidebarWidth: DocsWidget.DEFAULT_SIDEBAR_WIDTH,
            tocWidth: DocsWidget.DEFAULT_TOC_WIDTH,
            searchQuery: '',
            searchResults: [],
            searchOpen: false,
            searchLoading: false,
            tocItems: [],
            activeTocId: null,
            tocCollapsed: false
        };

        this.md = new MarkdownIt({ html: true, linkify: true, typographer: true });

        this.md.renderer.rules.heading_open = (
            tokens: MarkdownIt.Token[],
            idx: number,
            options: MarkdownIt.Options,
            env: unknown,
            self: MarkdownIt.Renderer
        ) => {
            const token = tokens[idx];
            const inlineToken = tokens[idx + 1];
            if (inlineToken && inlineToken.type === 'inline') {
                const text = inlineToken.content;
                const id = this.slugify(text);
                token.attrSet('id', id);
                if (token.tag === 'h2' || token.tag === 'h3' || token.tag === 'h4') {
                    this.tocItemsBuffer.push({ level: parseInt(token.tag[1]), text, id });
                }
            }
            return self.renderToken(tokens, idx, options);
        };

        this.md.renderer.rules.image = (
            tokens: MarkdownIt.Token[],
            idx: number,
            _options: MarkdownIt.Options,
            _env: unknown,
            self: MarkdownIt.Renderer
        ) => {
            const token = tokens[idx];
            let src = token.attrGet('src') || '';
            const alt = token.content || '';
            if (!src.startsWith('http') && !src.startsWith('/')) {
                src = this.getApiUrlWithQuery('docs-api/file', { path: this.resolveDocLink(src) });
            } else if (!src.startsWith('http')) {
                src = this.getApiUrlWithQuery('docs-api/file', { path: src });
            }
            return `<img src="${src}" alt="${alt}" class="nuke-doc-image" loading="lazy" />`;
        };

        this.md.renderer.rules.link_open = (
            tokens: MarkdownIt.Token[],
            idx: number,
            options: MarkdownIt.Options,
            env: unknown,
            self: MarkdownIt.Renderer
        ) => {
            const token = tokens[idx];
            const href = token.attrGet('href') || '';
            if (!href.startsWith('http') && !href.startsWith('#') && !href.startsWith('mailto:')) {
                token.attrSet('data-doc-link', href);
                token.attrSet('href', 'javascript:void(0)');
            }
            return self.renderToken(tokens, idx, options);
        };

        this.md.renderer.rules.fence = (
            tokens: MarkdownIt.Token[],
            idx: number,
            _options: MarkdownIt.Options,
            _env: unknown,
            _self: MarkdownIt.Renderer
        ) => {
            const token = tokens[idx];
            const info = token.info ? token.info.trim() : '';
            const lang = info.split(' ')[0];
            const code = token.content;
            return `<div class="nuke-code-block${lang ? ' nuke-code-block-' + lang : ''}">
        <div class="nuke-code-header"><span class="nuke-code-lang">${lang || 'text'}</span></div>
        <pre><code>${this.md.utils.escapeHtml(code)}</code></pre>
      </div>`;
        };
    }

    protected slugify(text: string): string {
        return text
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 64);
    }

    protected async onAfterAttach(msg: Message): Promise<void> {
        super.onAfterAttach(msg);
        await this.loadNav();
        await this.loadContent(this.state.currentPath);
    }

    protected getApiUrl(path: string): string {
        return new Endpoint({ path }).getRestUrl().toString();
    }

    protected getApiUrlWithQuery(path: string, query: Record<string, string>): string {
        const base = this.getApiUrl(path);
        const params = new URLSearchParams(query);
        return base + '?' + params.toString();
    }

    protected async loadNav(): Promise<void> {
        try {
            const res = await fetch(this.getApiUrl('docs-api/nav'));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.state.nav = await res.json();
            this.update();
        } catch (e) {
            this.state.error = 'Failed to load navigation';
            this.update();
        }
    }

    protected async loadContent(path: string): Promise<boolean> {
        this.state.loading = true;
        this.state.error = null;
        this.update();
        try {
            const url = this.getApiUrlWithQuery('docs-api/content', { path });
            const res = await fetch(url);
            if (!res.ok) {
                if (res.status === 404) {
                    throw new Error(`Page not found: ${path}`);
                }
                throw new Error(`HTTP ${res.status}`);
            }
            const text = await res.text();
            this.state.currentPath = path;
            this.tocItemsBuffer = [];
            this.state.content = this.renderMarkdown(text);
            this.state.tocItems = this.tocItemsBuffer;
            this.state.activeTocId = this.state.tocItems.length > 0 ? this.state.tocItems[0].id : null;
            this.tocItemsBuffer = [];
            return true;
        } catch (e) {
            this.state.error = `Failed to load ${path}: ${e}`;
            this.state.tocItems = [];
            this.state.activeTocId = null;
            return false;
        } finally {
            this.state.loading = false;
            this.update();
        }
    }

    protected renderMarkdown(text: string): string {
        let cleaned = text.replace(/^---\s*\n[\s\S]*?^---\s*\n/m, '');
        cleaned = cleaned.replace(/^:::\s*\w+.*$/gm, '');
        return this.md.render(cleaned);
    }

    protected handleSearch = (query: string): void => {
        this.state.searchQuery = query;
        if (this.searchDebounce) clearTimeout(this.searchDebounce);
        if (!query.trim()) {
            this.state.searchResults = [];
            this.state.searchOpen = false;
            this.state.searchLoading = false;
            this.update();
            return;
        }
        this.state.searchLoading = true;
        this.state.searchOpen = true;
        this.update();
        this.searchDebounce = setTimeout(async () => {
            try {
                const res = await fetch(this.getApiUrl(`docs-api/search?q=${encodeURIComponent(query)}`));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                this.state.searchResults = await res.json();
            } catch {
                this.state.searchResults = [];
            } finally {
                this.state.searchLoading = false;
                this.update();
            }
        }, 250);
    };

    protected toggleExpanded = (path: string): void => {
        if (this.state.expanded.has(path)) {
            this.state.expanded.delete(path);
        } else {
            this.state.expanded.add(path);
        }
        this.update();
    };

    protected getBreadcrumbs(path: string, items: DocsNavItem[]): DocsNavItem[] {
        for (const item of items) {
            if (item.path === path) return [item];
            if (item.children) {
                const found = this.getBreadcrumbs(path, item.children);
                if (found.length) return [item, ...found];
            }
        }
        return [];
    }

    protected resolveDocLink(href: string): string {
        const base = this.state.currentPath.substring(0, this.state.currentPath.lastIndexOf('/') + 1);
        let resolved = href.startsWith('/') ? href : base + href;

        const parts = resolved.split('/').filter((p) => p.length > 0);
        const stack: string[] = [];
        for (const part of parts) {
            if (part === '..') {
                stack.pop();
            } else if (part !== '.') {
                stack.push(part);
            }
        }
        resolved = '/' + stack.join('/');

        const extPrefixes = ['/nuke-core', '/nuke-visualizer', '/openmc-studio'];
        for (const prefix of extPrefixes) {
            const docsPath = prefix + '/docs/';
            if (resolved.startsWith(docsPath)) {
                resolved = prefix + '/' + resolved.slice(docsPath.length);
            }
        }

        if (resolved.endsWith('/README.md')) {
            resolved = resolved.replace(/\/README\.md$/, '/index.md');
        }

        if (!resolved.endsWith('.md')) {
            if (resolved.endsWith('/')) {
                resolved += 'index.md';
            } else {
                resolved += '.md';
            }
        }

        return resolved;
    }

    protected onClickLink = async (e: React.MouseEvent): Promise<void> => {
        const target = e.target as HTMLElement;
        const anchor = target.closest('a[data-doc-link]') as HTMLAnchorElement | null;
        if (anchor) {
            e.preventDefault();
            const href = anchor.getAttribute('data-doc-link');
            if (!href) return;
            const resolved = this.resolveDocLink(href);
            if (resolved.endsWith('.md')) {
                const success = await this.loadContent(resolved);
                if (!success) {
                    // If the .md file doesn't exist, try the bare path as a fallback
                    // (for non-markdown files linked from docs)
                    const barePath = resolved.replace(/\.md$/, '');
                    window.open(this.getApiUrlWithQuery('docs-api/file', { path: barePath }), '_blank');
                }
            } else {
                window.open(this.getApiUrlWithQuery('docs-api/file', { path: resolved }), '_blank');
            }
        }
    };

    protected handleContentScroll = (): void => {
        const content = this.contentRef.current;
        if (!content) return;

        const headings = content.querySelectorAll('h2[id], h3[id], h4[id]');
        if (headings.length === 0) return;

        const scrollTop = content.scrollTop;
        const offset = 24;

        let activeId: string | null = null;
        for (const heading of Array.from(headings)) {
            if (heading instanceof HTMLElement && heading.offsetTop <= scrollTop + offset) {
                activeId = heading.id;
            } else {
                break;
            }
        }

        if (activeId !== this.state.activeTocId) {
            this.state.activeTocId = activeId;
            this.update();
        }
    };

    protected scrollToHeading = (id: string): void => {
        const content = this.contentRef.current;
        if (!content) return;
        const heading = content.querySelector(`#${CSS.escape(id)}`);
        if (heading instanceof HTMLElement) {
            content.scrollTop = heading.offsetTop - 16;
        }
    };

    protected startSidebarResize = (e: React.MouseEvent): void => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = this.state.sidebarWidth;
        const container = this.containerRef.current;

        const onMouseMove = (moveEvent: MouseEvent): void => {
            const delta = moveEvent.clientX - startX;
            const newWidth = Math.max(DocsWidget.MIN_SIDEBAR_WIDTH, Math.min(DocsWidget.MAX_SIDEBAR_WIDTH, startWidth + delta));
            this.state.sidebarWidth = newWidth;
            if (container) {
                container.style.setProperty('--nuke-sidebar-width', `${newWidth}px`);
            }
        };

        const onMouseUp = (): void => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    protected startTocResize = (e: React.MouseEvent): void => {
        e.preventDefault();
        const startX = e.clientX;
        const startWidth = this.state.tocWidth;
        const container = this.containerRef.current;

        const onMouseMove = (moveEvent: MouseEvent): void => {
            const delta = startX - moveEvent.clientX; // reversed: dragging left increases width
            const newWidth = Math.max(DocsWidget.MIN_TOC_WIDTH, Math.min(DocsWidget.MAX_TOC_WIDTH, startWidth + delta));
            this.state.tocWidth = newWidth;
            if (container) {
                container.style.setProperty('--nuke-toc-width', `${newWidth}px`);
            }
        };

        const onMouseUp = (): void => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    };

    protected handleSelectSearchResult = (path: string): void => {
        this.loadContent(path);
        this.state.searchOpen = false;
        this.state.searchQuery = '';
        this.state.searchResults = [];
        this.update();
    };

    protected handleClearSearch = (): void => {
        this.state.searchQuery = '';
        this.state.searchResults = [];
        this.state.searchOpen = false;
        this.update();
    };

    render(): React.ReactNode {
        const breadcrumbs = this.getBreadcrumbs(this.state.currentPath, this.state.nav);
        const { sidebarCollapsed, tocCollapsed } = this.state;

        return (
            <div
                className="nuke-docs-container"
                ref={this.containerRef}
                style={
                    {
                        '--nuke-sidebar-width': `${this.state.sidebarWidth}px`,
                        '--nuke-toc-width': `${this.state.tocWidth}px`
                    } as React.CSSProperties
                }
            >
                <LoadingAnimations />

                {/* Left sidebar — fully hidden when collapsed */}
                {!sidebarCollapsed && (
                    <DocsSidebar
                        nav={this.state.nav}
                        expanded={this.state.expanded}
                        currentPath={this.state.currentPath}
                        searchQuery={this.state.searchQuery}
                        searchResults={this.state.searchResults}
                        searchOpen={this.state.searchOpen}
                        searchLoading={this.state.searchLoading}
                        onToggleExpanded={this.toggleExpanded}
                        onSelectItem={(path) => this.loadContent(path)}
                        onSearch={this.handleSearch}
                        onClearSearch={this.handleClearSearch}
                        onSelectSearchResult={this.handleSelectSearchResult}
                    />
                )}
                {!sidebarCollapsed && <div className="nuke-docs-resizer" onMouseDown={this.startSidebarResize} />}

                {/* Main content */}
                <div className="nuke-docs-main">
                    {/* Header toolbar with toggle buttons + breadcrumbs */}
                    <div className="nuke-docs-header">
                        <button
                            className="nuke-docs-header-toggle"
                            onClick={() => {
                                this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
                                this.update();
                            }}
                        >
                            <i className={codicon('menu')} />
                        </button>
                        <nav className="nuke-docs-breadcrumbs">
                            {breadcrumbs.map((item, i) => (
                                <React.Fragment key={item.path}>
                                    {i > 0 && (
                                        <span className="nuke-docs-breadcrumb-sep">
                                            <i className={codicon('chevron-right')} />
                                        </span>
                                    )}
                                    <button
                                        className={`nuke-docs-breadcrumb${i === breadcrumbs.length - 1 ? ' nuke-docs-breadcrumb-active' : ''}`}
                                        onClick={() => i < breadcrumbs.length - 1 && this.loadContent(item.path)}
                                    >
                                        {item.title}
                                    </button>
                                </React.Fragment>
                            ))}
                        </nav>
                        <button
                            className="nuke-docs-header-toggle"
                            onClick={() => {
                                this.state.tocCollapsed = !this.state.tocCollapsed;
                                this.update();
                            }}
                        >
                            <i className={codicon('list-selection')} />
                        </button>
                    </div>

                    {this.state.loading ? (
                        <SimpleLoadingSpinner message="Loading documentation..." />
                    ) : this.state.error ? (
                        <ErrorDisplay message={this.state.error} onRetry={() => this.loadContent(this.state.currentPath)} />
                    ) : (
                        <div
                            ref={this.contentRef}
                            className="nuke-docs-content"
                            dangerouslySetInnerHTML={{ __html: this.state.content }}
                            onClick={this.onClickLink}
                            onScroll={this.handleContentScroll}
                        />
                    )}
                </div>

                {/* Right resizer */}
                {!tocCollapsed && <div className="nuke-docs-resizer" onMouseDown={this.startTocResize} />}

                {/* TOC — fully hidden when collapsed */}
                {!tocCollapsed && <DocsToc items={this.state.tocItems} activeId={this.state.activeTocId} onSelect={this.scrollToHeading} />}
            </div>
        );
    }
}
