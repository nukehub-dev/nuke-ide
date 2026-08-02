// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// SPDX-License-Identifier: BSD-2-Clause
// *****************************************************************************

/**
 * Nuke Tools Sidebar Widget
 *
 * A left-panel view that collects {@link NukeToolsContribution}s and renders
 * them as a searchable, categorized list of commands. Clicking an item executes
 * its associated Theia command.
 *
 * @module nuke-core/browser/tools-sidebar
 */

import * as React from '@theia/core/shared/react';
import { injectable, inject, named, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandService } from '@theia/core/lib/common/command';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { NukeToolsContribution, NukeToolsItem, NukeToolsRegistry } from '../../common/nuke-tools-protocol';
import { CategoryKey, groupItems, NukeToolsCategory, sortItems } from './nuke-tools-sidebar-model';
import './nuke-tools-sidebar.css';

/** Storage key for persisted section expansion state. */
const EXPANDED_STORAGE_KEY = 'nuke-tools-sidebar:expanded';

interface NukeToolsSidebarState {
    items: NukeToolsItem[];
    query: string;
    expanded: Set<CategoryKey>;
}

@injectable()
export class NukeToolsSidebarWidget extends ReactWidget {
    static readonly ID = 'nuke-tools-sidebar';
    static readonly LABEL = 'Nuke Tools';

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(ContributionProvider)
    @named(NukeToolsContribution)
    protected readonly contributionProvider: ContributionProvider<NukeToolsContribution>;

    protected readonly state: NukeToolsSidebarState;
    protected searchDebounce: ReturnType<typeof setTimeout> | undefined;
    protected readonly enabledListeners = new DisposableCollection();

    constructor() {
        super();
        this.id = NukeToolsSidebarWidget.ID;
        this.title.label = NukeToolsSidebarWidget.LABEL;
        this.title.caption = NukeToolsSidebarWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = codicon('tools');
        this.node.classList.add('nuke-tools-sidebar');

        this.state = {
            items: [],
            query: '',
            expanded: new Set()
        };
    }

    @postConstruct()
    protected init(): void {
        this.loadExpandedState();
    }

    protected onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.loadItems();
    }

    /**
     * Collect tool items from every registered contribution.
     */
    protected async loadItems(): Promise<void> {
        this.enabledListeners.dispose();
        const registry: NukeToolsRegistry = {
            registerItem: (item: NukeToolsItem) => {
                this.state.items.push(item);
                if (item.onDidChangeEnabled) {
                    this.enabledListeners.push(item.onDidChangeEnabled(() => this.update()));
                }
            }
        };

        for (const contribution of this.contributionProvider.getContributions()) {
            await contribution.registerTools(registry);
        }

        this.sortItems();
        this.update();
    }

    /**
     * Sort items by category path then by order/label.
     */
    protected sortItems(): void {
        sortItems(this.state.items);
    }

    /**
     * Execute the command associated with a tool item.
     */
    protected executeItem(item: NukeToolsItem): void {
        this.commandService.executeCommand(item.commandId);
    }

    /**
     * Update the search query, debounced for performance.
     */
    protected setQuery(query: string): void {
        if (this.searchDebounce) {
            clearTimeout(this.searchDebounce);
        }
        this.searchDebounce = setTimeout(() => {
            this.state.query = query.trim().toLowerCase();
            this.update();
        }, 150);
    }

    /**
     * Toggle expansion of a category section.
     */
    protected toggleCategory(key: CategoryKey): void {
        if (this.state.expanded.has(key)) {
            this.state.expanded.delete(key);
        } else {
            this.state.expanded.add(key);
        }
        this.saveExpandedState();
        this.update();
    }

    /**
     * Build a nested tree of categories to their visible items.
     */
    protected getGroupedItems(): Map<CategoryKey, NukeToolsCategory> {
        return groupItems(this.state.items, this.state.query);
    }

    protected loadExpandedState(): void {
        try {
            const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw) as string[];
                this.state.expanded = new Set(parsed);
            }
        } catch {
            this.state.expanded = new Set();
        }
    }

    protected saveExpandedState(): void {
        try {
            localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(this.state.expanded)));
        } catch {
            // Ignore storage errors (e.g. private browsing).
        }
    }

    protected sortCategoryKeys(map: Map<CategoryKey, NukeToolsCategory>): CategoryKey[] {
        return Array.from(map.keys()).sort((a, b) => {
            const catA = map.get(a)!;
            const catB = map.get(b)!;
            const orderA = catA.order ?? catA.label;
            const orderB = catB.order ?? catB.label;
            return orderA.localeCompare(orderB);
        });
    }

    protected render(): React.ReactNode {
        const groups = this.getGroupedItems();
        const groupKeys = this.sortCategoryKeys(groups);

        return (
            <div className="nuke-tools-sidebar-container">
                <div className="nuke-tools-search">
                    <span className={codicon('search')} />
                    <input
                        type="text"
                        placeholder="Search Nuke tools..."
                        onChange={(e) => this.setQuery(e.currentTarget.value)}
                        aria-label="Search Nuke tools"
                    />
                </div>
                <div className="nuke-tools-content" role="tree">
                    {groupKeys.length === 0 ? (
                        <div className="nuke-tools-empty">No tools found.</div>
                    ) : (
                        groupKeys.map((key) => this.renderCategory([key], groups.get(key)!))
                    )}
                </div>
            </div>
        );
    }

    protected renderCategory(path: CategoryKey[], group: NukeToolsCategory): React.ReactNode {
        const key = path.join('/');
        const expanded = this.state.expanded.has(key);
        const toggleIcon = expanded ? codicon('chevron-down') : codicon('chevron-right');
        const subcategoryKeys = this.sortCategoryKeys(group.subcategories);

        return (
            <div key={key} className="nuke-tools-category" role="group" aria-expanded={expanded}>
                <div
                    className="nuke-tools-category-header"
                    onClick={() => this.toggleCategory(key)}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            this.toggleCategory(key);
                        }
                    }}
                >
                    <span className={`nuke-tools-category-toggle ${toggleIcon}`} />
                    <span className="nuke-tools-category-label">{group.label}</span>
                </div>
                {expanded && (
                    <div className="nuke-tools-category-items">
                        {group.items.map((item) => this.renderItem(item))}
                        {subcategoryKeys.map((subKey) => this.renderCategory([...path, subKey], group.subcategories.get(subKey)!))}
                    </div>
                )}
            </div>
        );
    }

    protected renderItem(item: NukeToolsItem): React.ReactNode {
        const iconClass = item.icon ? codicon(item.icon) : codicon('circle-small');
        const disabled = item.enabled ? !item.enabled() : false;
        const className = `nuke-tools-item${disabled ? ' nuke-tools-item-disabled' : ''}`;

        return (
            <div
                key={`${item.commandId}:${item.id}`}
                className={className}
                role="treeitem"
                aria-disabled={disabled}
                title={item.description ?? item.label}
                onClick={() => {
                    if (!disabled) {
                        this.executeItem(item);
                    }
                }}
                tabIndex={disabled ? -1 : 0}
                onKeyDown={(e) => {
                    if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        this.executeItem(item);
                    }
                }}
            >
                <span className={`nuke-tools-item-icon ${iconClass}`} />
                <span className="nuke-tools-item-label">{item.label}</span>
            </div>
        );
    }
}
