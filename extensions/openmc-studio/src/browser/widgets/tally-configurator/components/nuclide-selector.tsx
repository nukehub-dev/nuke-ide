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

import * as React from 'react';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

/**
 * Props for the {@link NuclideSelector} component.
 */
interface NuclideSelectorProps {
    /** Selected nuclide names */
    nuclides: string[];
    /** Callback when the nuclide list changes */
    onUpdate: (nuclides: string[]) => void;
}

/**
 * Component for adding and removing nuclides from a tally.
 *
 * Users can type nuclide names (e.g. U235, Pu239) and press Enter to add them.
 *
 * @see {@link TallyEditor}
 */
export const NuclideSelector: React.FC<NuclideSelectorProps> = ({ nuclides, onUpdate }) => {
    const [inputValue, setInputValue] = React.useState('');

    /** Add the current input value as a nuclide if not already present. */
    const addNuclide = () => {
        if (!inputValue) return;
        if (!nuclides.includes(inputValue)) {
            onUpdate([...nuclides, inputValue]);
        }
        setInputValue('');
    };

    /** Remove a nuclide from the selection. */
    const removeNuclide = (nuclide: string) => {
        onUpdate(nuclides.filter((n) => n !== nuclide));
    };

    /** Handle Enter key to add the current nuclide input. */
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            addNuclide();
        }
    };

    return (
        <div className="nuclide-selector">
            <div className="nuclide-list">
                {nuclides.map((nuclide) => (
                    <div key={nuclide} className="nuclide-badge">
                        <span className="nuclide-name">{nuclide}</span>
                        <Tooltip content="Remove nuclide" position="top">
                            <button className="remove-nuclide-btn" onClick={() => removeNuclide(nuclide)} aria-label="Remove">
                                <i className="codicon codicon-close"></i>
                            </button>
                        </Tooltip>
                    </div>
                ))}
                {nuclides.length === 0 && <span className="nuclide-empty-hint">No nuclides selected</span>}
            </div>
            <div className="nuclide-input-row">
                <div className="nuclide-input-wrapper">
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="e.g. U235, Pu239"
                    />
                    <span className="nuclide-input-hint">Press Enter to add</span>
                </div>
                <Tooltip content="Add nuclide to list" position="top">
                    <button
                        className="nuclide-action-btn nuclide-add-btn"
                        onClick={addNuclide}
                        disabled={!inputValue}
                        aria-label="Add nuclide"
                    >
                        <i className="codicon codicon-add"></i>
                    </button>
                </Tooltip>
                <Tooltip content="Reset to total neutron reaction (default)" position="top">
                    <button
                        className="nuclide-action-btn nuclide-reset-btn"
                        onClick={() => onUpdate(['total'])}
                        aria-label="Reset to total"
                    >
                        <i className="codicon codicon-refresh"></i>
                    </button>
                </Tooltip>
            </div>
        </div>
    );
};
