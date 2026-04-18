// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as React from 'react';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';

interface NuclideSelectorProps {
    nuclides: string[];
    onUpdate: (nuclides: string[]) => void;
}

export const NuclideSelector: React.FC<NuclideSelectorProps> = ({ nuclides, onUpdate }) => {
    const [inputValue, setInputValue] = React.useState('');

    const addNuclide = () => {
        if (!inputValue) return;
        if (!nuclides.includes(inputValue)) {
            onUpdate([...nuclides, inputValue]);
        }
        setInputValue('');
    };

    const removeNuclide = (nuclide: string) => {
        onUpdate(nuclides.filter(n => n !== nuclide));
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            addNuclide();
        }
    };

    return (
        <div className='nuclide-selector'>
            <div className='nuclide-list'>
                {nuclides.map(nuclide => (
                    <div key={nuclide} className='nuclide-badge'>
                        <span className='nuclide-name'>{nuclide}</span>
                        <Tooltip content='Remove nuclide' position='top'>
                            <button 
                                className='remove-nuclide-btn' 
                                onClick={() => removeNuclide(nuclide)}
                                aria-label='Remove'
                            >
                                <i className='codicon codicon-close'></i>
                            </button>
                        </Tooltip>
                    </div>
                ))}
                {nuclides.length === 0 && (
                    <span className='nuclide-empty-hint'>No nuclides selected</span>
                )}
            </div>
            <div className='nuclide-input-row'>
                <div className='nuclide-input-wrapper'>
                    <input 
                        type='text' 
                        value={inputValue} 
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder='e.g. U235, Pu239'
                    />
                    <span className='nuclide-input-hint'>Press Enter to add</span>
                </div>
                <Tooltip content='Add nuclide to list' position='top'>
                    <button 
                        className='nuclide-action-btn nuclide-add-btn' 
                        onClick={addNuclide}
                        disabled={!inputValue}
                        aria-label='Add nuclide'
                    >
                        <i className='codicon codicon-add'></i>
                    </button>
                </Tooltip>
                <Tooltip content='Reset to total neutron reaction (default)' position='top'>
                    <button 
                        className='nuclide-action-btn nuclide-reset-btn' 
                        onClick={() => onUpdate(['total'])}
                        aria-label='Reset to total'
                    >
                        <i className='codicon codicon-refresh'></i>
                    </button>
                </Tooltip>
            </div>
        </div>
    );
};
