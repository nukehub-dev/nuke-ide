// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as React from '@theia/core/shared/react';
import { Tooltip } from './tooltip';

export interface ColorPickerProps {
    value: string;
    onChange: (color: string) => void;
}

const COLOR_GROUPS = [
    { name: 'Reds', colors: ['#FFEBEE', '#FFCDD2', '#EF9A9A', '#E57373', '#EF5350', '#F44336', '#E53935', '#D32F2F', '#C62828', '#B71C1C'] },
    { name: 'Pinks', colors: ['#FCE4EC', '#F8BBD9', '#F48FB1', '#F06292', '#EC407A', '#E91E63', '#D81B60', '#C2185B', '#AD1457', '#880E4F'] },
    { name: 'Purples', colors: ['#F3E5F5', '#E1BEE7', '#CE93D8', '#BA68C8', '#AB47BC', '#9C27B0', '#8E24AA', '#7B1FA2', '#6A1B9A', '#4A148C'] },
    { name: 'Indigos', colors: ['#E8EAF6', '#C5CAE9', '#9FA8DA', '#7986CB', '#5C6BC0', '#3F51B5', '#3949AB', '#303F9F', '#283593', '#1A237E'] },
    { name: 'Blues', colors: ['#E3F2FD', '#BBDEFB', '#90CAF9', '#64B5F6', '#42A5F5', '#2196F3', '#1E88E5', '#1976D2', '#1565C0', '#0D47A1'] },
    { name: 'Cyans', colors: ['#E0F7FA', '#B2EBF2', '#80DEEA', '#4FC3F7', '#26C6DA', '#00BCD4', '#00ACC1', '#0097A7', '#00838F', '#006064'] },
    { name: 'Teals', colors: ['#E0F2F1', '#B2DFDB', '#80CBC4', '#4DB6AC', '#26A69A', '#009688', '#00897B', '#00796B', '#00695C', '#004D40'] },
    { name: 'Greens', colors: ['#E8F5E9', '#C8E6C9', '#A5D6A7', '#81C784', '#66BB6A', '#4CAF50', '#43A047', '#388E3C', '#2E7D32', '#1B5E20'] },
    { name: 'Yellows', colors: ['#FFFDE7', '#FFF9C4', '#FFF59D', '#FFF176', '#FFEE58', '#FFEB3B', '#FDD835', '#FBC02D', '#F9A825', '#F57F17'] },
    { name: 'Oranges', colors: ['#FFF3E0', '#FFE0B2', '#FFCC80', '#FFB74D', '#FFA726', '#FF9800', '#FB8C00', '#F57C00', '#EF6C00', '#E65100'] },
    { name: 'Browns', colors: ['#EFEBE9', '#D7CCC8', '#BCAAA4', '#A1887F', '#8D6E63', '#795548', '#6D4C41', '#5D4037', '#4E342E', '#3E2723'] },
    { name: 'Greys', colors: ['#FAFAFA', '#F5F5F5', '#EEEEEE', '#E0E0E0', '#BDBDBD', '#9E9E9E', '#757575', '#616161', '#424242', '#212121'] }
];

export const ColorPicker: React.FC<ColorPickerProps> = ({ value, onChange }) => {
    const [isOpen, setIsOpen] = React.useState(false);
    const [hexInput, setHexInput] = React.useState(value);
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => { setHexInput(value); }, [value]);

    React.useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        if (isOpen) document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen]);

    const handleSelect = (color: string) => {
        onChange(color);
        setIsOpen(false);
    };

    const handleHexSubmit = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && /^#[0-9A-Fa-f]{6}$/.test(hexInput.trim())) {
            onChange(hexInput.trim().toUpperCase());
            setIsOpen(false);
        }
    };

    return (
        <div className="nuke-color-picker" ref={containerRef}>
            <button className="nuke-color-picker-trigger" onClick={() => setIsOpen(!isOpen)}>
                <Tooltip content="Click to change color" position="top">
                    <span className="nuke-color-preview" style={{ backgroundColor: value }} />
                </Tooltip>
                <span className="nuke-color-value">{value}</span>
                <i className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} />
            </button>

            {isOpen && (
                <div className="nuke-color-picker-popup">
                    <div className="nuke-color-picker-header">
                        <span>Select Color</span>
                        <button className="nuke-color-picker-close" onClick={() => setIsOpen(false)}>
                            <i className="codicon codicon-close" />
                        </button>
                    </div>

                    <div className="nuke-color-groups">
                        {COLOR_GROUPS.map(group => (
                            <div key={group.name} className="nuke-color-group">
                                <div className="nuke-color-group-name">{group.name}</div>
                                <div className="nuke-color-row">
                                    {group.colors.map(color => (
                                        <Tooltip key={color} content={color} position="top" delay={100}>
                                            <button
                                                className={`nuke-color-swatch ${value === color ? 'selected' : ''}`}
                                                style={{ backgroundColor: color }}
                                                onClick={() => handleSelect(color)}
                                            />
                                        </Tooltip>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="nuke-color-hex-input">
                        <span>Hex:</span>
                        <input
                            type="text"
                            value={hexInput}
                            onChange={e => setHexInput(e.target.value)}
                            onKeyDown={handleHexSubmit}
                            placeholder="#000000"
                            className={/^#[0-9A-Fa-f]{6}$/.test(hexInput.trim()) ? 'valid' : 'invalid'}
                        />
                    </div>
                </div>
            )}
        </div>
    );
};
