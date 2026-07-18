import * as React from 'react';
import { codicon } from '@theia/core/lib/browser';
import { DocsNavItem, SearchResult } from './docs-widget';

export interface DocsSidebarProps {
    nav: DocsNavItem[];
    expanded: Set<string>;
    currentPath: string;
    searchQuery: string;
    searchResults: SearchResult[];
    searchOpen: boolean;
    searchLoading: boolean;
    onToggleExpanded: (path: string) => void;
    onSelectItem: (path: string) => void;
    onSearch: (query: string) => void;
    onClearSearch: () => void;
    onSelectSearchResult: (path: string) => void;
}

export const DocsSidebar = (props: DocsSidebarProps): React.ReactElement => {
    const {
        nav,
        expanded,
        currentPath,
        searchQuery,
        searchResults,
        searchOpen,
        searchLoading,
        onToggleExpanded,
        onSelectItem,
        onSearch,
        onClearSearch,
        onSelectSearchResult
    } = props;

    const renderSearchDropdown = (): React.ReactNode => (
        <div className="nuke-docs-search-dropdown">
            {searchLoading ? (
                <div className="nuke-docs-search-loading">
                    <i className={codicon('loading')} /> Searching...
                </div>
            ) : searchResults.length === 0 ? (
                <div className="nuke-docs-search-empty">No results found</div>
            ) : (
                <div className="nuke-docs-search-results">
                    {searchResults.map((r) => (
                        <button key={r.path} className="nuke-docs-search-result" onClick={() => onSelectSearchResult(r.path)}>
                            <div className="nuke-docs-search-result-title">
                                <i className={codicon('file')} />
                                {r.title}
                            </div>
                            <div className="nuke-docs-search-result-snippet">{r.snippet}</div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );

    const renderNavItem = (item: DocsNavItem, depth: number): React.ReactNode => {
        const isExpanded = expanded.has(item.path);
        const isActive = currentPath === item.path;
        const hasChildren = item.children && item.children.length > 0;

        return (
            <div key={item.path} className="nuke-docs-nav-item">
                <div
                    className={`nuke-docs-nav-row${isActive ? ' nuke-docs-nav-active' : ''}`}
                    style={{ paddingLeft: `${12 + depth * 16}px` }}
                >
                    {hasChildren ? (
                        <button
                            className={`nuke-docs-nav-chevron${isExpanded ? ' nuke-docs-nav-chevron-expanded' : ''}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleExpanded(item.path);
                            }}
                        >
                            <i className={codicon('chevron-right')} />
                        </button>
                    ) : (
                        <span className="nuke-docs-nav-spacer" />
                    )}
                    <button className="nuke-docs-nav-link" onClick={() => onSelectItem(item.path)}>
                        <span className="nuke-docs-nav-label">{item.title}</span>
                    </button>
                </div>
                {hasChildren && isExpanded && (
                    <div className="nuke-docs-nav-children">{item.children!.map((child) => renderNavItem(child, depth + 1))}</div>
                )}
            </div>
        );
    };

    return (
        <aside className="nuke-docs-sidebar">
            <div className="nuke-docs-sidebar-header">
                <i className={codicon('book')} />
                <span>Documentation</span>
            </div>
            <div className="nuke-docs-search">
                <i className={codicon('search')} />
                <input
                    type="text"
                    placeholder="Search docs..."
                    value={searchQuery}
                    onChange={(e) => onSearch(e.target.value)}
                    onFocus={() => onSearch(searchQuery)}
                />
                {searchQuery && (
                    <button className="nuke-docs-search-clear" onClick={onClearSearch}>
                        <i className={codicon('close')} />
                    </button>
                )}
                {searchOpen && renderSearchDropdown()}
            </div>
            <nav className="nuke-docs-nav">{nav.map((item) => renderNavItem(item, 0))}</nav>
        </aside>
    );
};
