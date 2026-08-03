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

import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';

export interface SearchableMultiSelectOption {
    /** Stable identifier; also the value returned on selection. */
    id: string | number;
    /** Primary label shown for the option. */
    label: string;
    /** Optional secondary hint rendered in muted text. */
    description?: string;
}

export interface SearchableMultiSelectProps {
    /** Available options. */
    options: SearchableMultiSelectOption[];
    /** Currently selected IDs. */
    selectedIds: (string | number)[];
    /** Called when the selection changes. */
    onChange: (selectedIds: (string | number)[]) => void;
    /** Placeholder shown on the closed trigger. */
    placeholder?: string;
    /** Placeholder shown in the search input. */
    searchPlaceholder?: string;
    /** Message shown when the filtered list is empty. */
    emptyMessage?: string;
    /** Maximum height of the option list, in pixels. */
    maxHeight?: number;
}

/**
 * Dropdown searchable multi-select.
 *
 * Renders a compact trigger button. When opened, a portal dropdown shows a
 * filter input and a scrollable list of checkable rows. Each row matches
 * against the option label, description, and stringified id.
 */
export const SearchableMultiSelect: React.FC<SearchableMultiSelectProps> = ({
    options,
    selectedIds,
    onChange,
    placeholder = 'Select…',
    searchPlaceholder = 'Search…',
    emptyMessage = 'No matching items',
    maxHeight = 200
}) => {
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const dropdownRef = React.useRef<HTMLDivElement>(null);
    const selectedSet = React.useMemo(() => new Set(selectedIds.map(String)), [selectedIds]);

    const filtered = React.useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) {
            return options;
        }
        return options.filter((opt) => {
            const idText = String(opt.id).toLowerCase();
            const labelText = opt.label.toLowerCase();
            const descText = (opt.description ?? '').toLowerCase();
            return idText.includes(normalized) || labelText.includes(normalized) || descText.includes(normalized);
        });
    }, [options, query]);

    const toggle = (id: string | number) => {
        const key = String(id);
        const next = selectedSet.has(key) ? selectedIds.filter((sid) => String(sid) !== key) : [...selectedIds, id];
        onChange(next);
    };

    // Close when clicking outside the dropdown or pressing Escape.
    React.useEffect(() => {
        if (!open) return;
        const onMouseDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (dropdownRef.current?.contains(target) || triggerRef.current?.contains(target)) {
                return;
            }
            setOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onMouseDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onMouseDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    // Clear search each time the dropdown opens.
    React.useEffect(() => {
        if (open) {
            setQuery('');
        }
    }, [open]);

    const triggerLabel = selectedIds.length === 0 ? placeholder : `${selectedIds.length} selected`;

    const dropdown = open && (
        <div ref={dropdownRef} className="nuke-searchable-multi-select-dropdown" style={computeDropdownPosition(triggerRef.current)}>
            <div className="nuke-searchable-multi-select-input">
                <i className="codicon codicon-search"></i>
                <input type="text" value={query} placeholder={searchPlaceholder} onChange={(e) => setQuery(e.target.value)} autoFocus />
                {query && (
                    <button className="nuke-searchable-multi-select-clear" onClick={() => setQuery('')} type="button">
                        <i className="codicon codicon-close"></i>
                    </button>
                )}
            </div>
            <ul className="nuke-searchable-multi-select-list" style={{ maxHeight }}>
                {filtered.length === 0 ? (
                    <li className="nuke-searchable-multi-select-empty">{emptyMessage}</li>
                ) : (
                    filtered.map((opt) => {
                        const isSelected = selectedSet.has(String(opt.id));
                        return (
                            <li
                                key={String(opt.id)}
                                className={`nuke-searchable-multi-select-item${isSelected ? ' selected' : ''}`}
                                onClick={() => toggle(opt.id)}
                            >
                                <input type="checkbox" checked={isSelected} readOnly tabIndex={-1} />
                                <span className="nuke-searchable-multi-select-label">{opt.label}</span>
                                <span className="nuke-searchable-multi-select-id">{opt.id}</span>
                            </li>
                        );
                    })
                )}
            </ul>
            <div className="nuke-searchable-multi-select-footer">
                {selectedIds.length > 0 ? `${selectedIds.length} selected` : 'None selected'}
            </div>
        </div>
    );

    return (
        <>
            <button
                ref={triggerRef}
                type="button"
                className="nuke-searchable-multi-select-trigger"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
            >
                <span className="nuke-searchable-multi-select-trigger-label">{triggerLabel}</span>
                <i className={`codicon codicon-chevron-${open ? 'up' : 'down'}`}></i>
            </button>
            {dropdown && ReactDOM.createPortal(dropdown, document.body)}
        </>
    );
};

function computeDropdownPosition(trigger: HTMLButtonElement | null): React.CSSProperties {
    if (!trigger) {
        return { position: 'fixed', left: 0, top: 0, visibility: 'hidden' };
    }
    const rect = trigger.getBoundingClientRect();
    return {
        position: 'fixed',
        left: rect.left,
        top: rect.bottom + 4,
        width: rect.width,
        zIndex: 99999
    };
}
