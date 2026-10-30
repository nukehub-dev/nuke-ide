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

export interface NukeSelectOption {
    value: string;
    label: string;
    disabled?: boolean;
}

export interface NukeSelectProps {
    value: string;
    onChange: (value: string) => void;
    options: readonly NukeSelectOption[];
    placeholder?: string;
    disabled?: boolean;
    ariaLabel?: string;
    className?: string;
    triggerClassName?: string;
    /** Layout passthrough on the root (e.g. `{ width: '100%' }`); paint lives in CSS. */
    style?: React.CSSProperties;
}

const DROPDOWN_MAX_HEIGHT = 240;
const DROPDOWN_GAP = 4;

/**
 * Shared custom select replacing builtin `<select>` elements across the IDE.
 *
 * A themed trigger button (Theia input tokens, codicon chevron) opens a
 * viewport-anchored dropdown portal — narrow sidebars and scrolling panels
 * can never clip it. Full keyboard support (ArrowUp/Down skipping disabled
 * entries, Home/End, Enter/Space to pick, Escape/Tab to dismiss), a hidden
 * native select preserving form semantics, and ARIA listbox wiring. Opens
 * below the trigger, flipping above when there is no room (measured from
 * the live list height, like the color picker); positions before first
 * paint so the list never flashes at the fallback corner.
 */
export const NukeSelect: React.FC<NukeSelectProps> = ({
    value,
    onChange,
    options,
    placeholder = 'Select an option',
    disabled = false,
    ariaLabel,
    className,
    triggerClassName,
    style
}) => {
    const [open, setOpen] = React.useState(false);
    const [highlightedIndex, setHighlightedIndex] = React.useState(-1);
    const [dropdownCoords, setDropdownCoords] = React.useState<{ x: number; y: number } | null>(null);
    const containerRef = React.useRef<HTMLDivElement>(null);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const listRef = React.useRef<HTMLDivElement>(null);
    const listId = React.useId();

    const selectedOption = options.find((option) => option.value === value);
    // Every option renders as a pickable row (native-select parity): an
    // empty-valued option is a real choice (e.g. "All", "Toggle material…"),
    // and `placeholder` is only the trigger fallback when nothing matches.
    const dropdownOptions = options;
    const hasEmptyOption = options.some((option) => option.value === '');

    const close = React.useCallback(() => {
        setOpen(false);
        setHighlightedIndex(-1);
    }, []);

    const placeDropdown = React.useCallback(() => {
        const trigger = triggerRef.current;
        if (!trigger) {
            return;
        }
        const rect = trigger.getBoundingClientRect();
        const height = Math.min(listRef.current?.offsetHeight ?? DROPDOWN_MAX_HEIGHT, DROPDOWN_MAX_HEIGHT);
        const spaceBelow = window.innerHeight - rect.bottom - DROPDOWN_GAP;
        const spaceAbove = rect.top - DROPDOWN_GAP;
        const placeTop = spaceBelow < height && spaceAbove > spaceBelow;
        const x = Math.min(Math.max(rect.left, 8), Math.max(window.innerWidth - 8, 8));
        const y = placeTop ? rect.top - DROPDOWN_GAP - height : rect.bottom + DROPDOWN_GAP;
        setDropdownCoords((prev) => (prev !== null && prev.x === x && prev.y === y ? prev : { x, y }));
    }, []);

    // Position before first paint and render the list only once coords exist.
    React.useLayoutEffect(() => {
        if (open) {
            const selectedIndex = dropdownOptions.findIndex((option) => option.value === value && !option.disabled);
            setHighlightedIndex(selectedIndex);
            placeDropdown();
        } else {
            setDropdownCoords(null);
        }
    }, [open, placeDropdown]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-measure once the list DOM exists so the flip decision uses the real
    // height instead of the pre-mount estimate.
    React.useLayoutEffect(() => {
        if (open && dropdownCoords !== null) {
            placeDropdown();
        }
    });

    React.useEffect(() => {
        if (!open) {
            return;
        }
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (containerRef.current?.contains(target) || listRef.current?.contains(target)) {
                return;
            }
            close();
        };
        document.addEventListener('mousedown', handleClickOutside);
        window.addEventListener('scroll', placeDropdown, true);
        window.addEventListener('resize', placeDropdown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            window.removeEventListener('scroll', placeDropdown, true);
            window.removeEventListener('resize', placeDropdown);
        };
    }, [open, close, placeDropdown]);

    React.useEffect(() => {
        if (open && highlightedIndex >= 0) {
            document.getElementById(`${listId}-option-${highlightedIndex}`)?.scrollIntoView({ block: 'nearest' });
        }
    }, [open, highlightedIndex, listId]);

    const stepHighlight = (direction: 1 | -1): void => {
        if (dropdownOptions.length === 0) {
            return;
        }
        let index = highlightedIndex;
        for (let step = 0; step < dropdownOptions.length; step++) {
            index = (index + direction + dropdownOptions.length) % dropdownOptions.length;
            if (!dropdownOptions[index].disabled) {
                setHighlightedIndex(index);
                return;
            }
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent) => {
        if (disabled) {
            return;
        }
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                if (!open) {
                    setOpen(true);
                } else {
                    stepHighlight(1);
                }
                break;
            case 'ArrowUp':
                event.preventDefault();
                if (!open) {
                    setOpen(true);
                } else {
                    stepHighlight(-1);
                }
                break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                if (!open) {
                    setOpen(true);
                } else if (highlightedIndex >= 0 && !dropdownOptions[highlightedIndex].disabled) {
                    onChange(dropdownOptions[highlightedIndex].value);
                    close();
                }
                break;
            case 'Escape':
                event.preventDefault();
                close();
                break;
            case 'Tab':
                if (open) {
                    close();
                }
                break;
            case 'Home':
                if (open) {
                    event.preventDefault();
                    const first = dropdownOptions.findIndex((option) => !option.disabled);
                    setHighlightedIndex(first);
                }
                break;
            case 'End':
                if (open) {
                    event.preventDefault();
                    const last = [...dropdownOptions.keys()].reverse().find((index) => !dropdownOptions[index].disabled) ?? -1;
                    setHighlightedIndex(last);
                }
                break;
        }
    };

    const handleOptionClick = (optionValue: string) => {
        onChange(optionValue);
        close();
        triggerRef.current?.focus();
    };

    return (
        <div ref={containerRef} className={`nuke-select${className ? ` ${className}` : ''}`} style={style}>
            {/* Hidden native select keeps form semantics and accessibility simple. */}
            <select
                value={value || ''}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className="nuke-select-native"
                tabIndex={-1}
                aria-hidden="true"
            >
                {!hasEmptyOption && (
                    <option value="" disabled>
                        {placeholder}
                    </option>
                )}
                {options.map((option) => (
                    <option key={option.value} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>

            <button
                ref={triggerRef}
                type="button"
                role="combobox"
                aria-expanded={open}
                aria-haspopup="listbox"
                aria-controls={listId}
                aria-activedescendant={open && highlightedIndex >= 0 ? `${listId}-option-${highlightedIndex}` : undefined}
                aria-label={ariaLabel}
                disabled={disabled}
                onClick={() => !disabled && setOpen(!open)}
                onKeyDown={handleKeyDown}
                className={`nuke-select-trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}
            >
                <span className={`nuke-select-value${selectedOption ? '' : ' nuke-select-placeholder'}`}>
                    {selectedOption ? selectedOption.label : placeholder}
                </span>
                <i className={`codicon codicon-chevron-down nuke-select-chevron${open ? ' is-open' : ''}`} />
            </button>

            {open &&
                dropdownCoords !== null &&
                ReactDOM.createPortal(
                    <div
                        ref={listRef}
                        className="nuke-select-list"
                        style={{
                            position: 'fixed',
                            left: dropdownCoords.x,
                            top: dropdownCoords.y,
                            minWidth: triggerRef.current?.offsetWidth,
                            maxWidth: `calc(100vw - ${dropdownCoords.x + 8}px)`
                        }}
                    >
                        <ul id={listId} role="listbox" className="nuke-select-options">
                            {dropdownOptions.map((option, index) => {
                                const isHighlighted = highlightedIndex === index;
                                const isSelected = option.value === value;
                                return (
                                    <li
                                        key={option.value}
                                        id={`${listId}-option-${index}`}
                                        role="option"
                                        aria-selected={isSelected}
                                        aria-disabled={option.disabled}
                                        onMouseEnter={() => !option.disabled && setHighlightedIndex(index)}
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => {
                                            if (!option.disabled) {
                                                handleOptionClick(option.value);
                                            }
                                        }}
                                        className={
                                            `nuke-select-option${isHighlighted ? ' is-highlighted' : ''}` +
                                            `${isSelected ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`
                                        }
                                    >
                                        <i className="codicon codicon-check nuke-select-check" style={{ opacity: isSelected ? 1 : 0 }} />
                                        <span className="nuke-select-option-label">{option.label}</span>
                                    </li>
                                );
                            })}
                        </ul>
                    </div>,
                    document.body
                )}
        </div>
    );
};
