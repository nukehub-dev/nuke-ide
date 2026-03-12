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
import { injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import { OpenMCSpectrumData, OpenMCSpatialPlotData } from '../../common/visualizer-protocol';

@injectable()
export class OpenMCPlotWidget extends ReactWidget {
    static readonly ID = 'openmc-plot-widget';
    static readonly LABEL = 'OpenMC Plot';

    private data: OpenMCSpectrumData | OpenMCSpatialPlotData | null = null;
    private plotType: 'spectrum' | 'spatial' = 'spectrum';
    private titleText: string = 'OpenMC Plot';

    @postConstruct()
    protected init(): void {
        this.id = OpenMCPlotWidget.ID;
        this.title.label = OpenMCPlotWidget.LABEL;
        this.title.caption = OpenMCPlotWidget.LABEL;
        this.title.iconClass = codicon('graph');
        this.title.closable = true;

        // Ensure the widget can be focused
        this.node.tabIndex = 0;
        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setData(data: OpenMCSpectrumData | OpenMCSpatialPlotData, type: 'spectrum' | 'spatial', title: string): void {
        this.data = data;
        this.plotType = type;
        this.titleText = title;
        this.title.label = title;
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.data) {
            return <div className="openmc-plot empty" style={{ padding: '20px', textAlign: 'center' }}>No data to display</div>;
        }

        return (
            <div className="openmc-plot" style={{ 
                padding: '20px', 
                height: '100%', 
                display: 'flex', 
                flexDirection: 'column',
                backgroundColor: '#1e1e1e',
                color: '#cccccc',
                fontFamily: 'Segoe UI, Tahoma, Geneva, Verdana, sans-serif'
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                    <h3 style={{ margin: 0, color: '#fff' }}>{this.titleText}</h3>
                    <div style={{ fontSize: '12px', color: '#888' }}>
                        {this.plotType === 'spectrum' ? 'Log-Log Scale' : 'Linear Scale'}
                    </div>
                </div>
                <div style={{ flex: 1, position: 'relative', minHeight: '300px' }}>
                    {this.plotType === 'spectrum' ? 
                        this.renderSpectrum(this.data as OpenMCSpectrumData) : 
                        this.renderSpatial(this.data as OpenMCSpatialPlotData)}
                </div>
            </div>
        );
    }

    private formatValue(val: number): string {
        if (val === 0) return '0';
        const abs = Math.abs(val);
        if (abs < 0.01 || abs >= 10000) {
            return val.toExponential(2);
        }
        return val.toFixed(2);
    }

    private renderSpectrum(data: OpenMCSpectrumData): React.ReactNode {
        const x = data.energy_bins;
        const y = data.values;
        if (!x || !y || x.length < 1) return <div style={{ color: '#f44336' }}>Invalid spectrum data</div>;

        const width = 1000;
        const height = 500;
        const padding = 60;
        const plotWidth = width - 2 * padding;
        const plotHeight = height - 2 * padding;

        // X scale (Log)
        const minX = Math.max(x[0], 1e-11);
        const maxX = x[x.length - 1];
        const logMinX = Math.log10(minX);
        const logMaxX = Math.log10(maxX);
        const getX = (val: number) => padding + (Math.log10(Math.max(val, minX)) - logMinX) / (logMaxX - logMinX) * plotWidth;

        // Y scale (Log)
        const validY = y.filter(v => v > 0);
        let minY = validY.length > 0 ? Math.min(...validY) : 1e-10;
        let maxY = validY.length > 0 ? Math.max(...validY) : 1e-1;
        
        // If single bin or all same values, create a range
        if (minY === maxY) {
            minY = minY * 0.1;
            maxY = maxY * 10;
        } else {
            // Add padding to range
            minY = Math.pow(10, Math.log10(minY) - 0.2);
            maxY = Math.pow(10, Math.log10(maxY) + 0.2);
        }
        
        const logMinY = Math.log10(minY);
        const logMaxY = Math.log10(maxY);
        const getY = (val: number) => {
            if (val <= 0) return height - padding;
            return height - padding - (Math.log10(val) - logMinY) / (logMaxY - logMinY) * plotHeight;
        };

        // Grid lines (X)
        const xTicks = [];
        for (let i = Math.floor(logMinX); i <= Math.ceil(logMaxX); i++) {
            const val = Math.pow(10, i);
            if (val >= minX && val <= maxX) {
                const px = getX(val);
                xTicks.push(
                    <g key={`x-${i}`}>
                        <line x1={px} y1={padding} x2={px} y2={height - padding} stroke="#333" strokeWidth="1" />
                        <text x={px} y={height - padding + 20} fill="#888" textAnchor="middle" fontSize="12">10{<sup>{i}</sup>}</text>
                    </g>
                );
            }
        }

        // Grid lines (Y)
        const yTicks = [];
        for (let i = Math.floor(logMinY); i <= Math.ceil(logMaxY); i++) {
            const val = Math.pow(10, i);
            if (val >= minY && val <= maxY) {
                const py = getY(val);
                yTicks.push(
                    <g key={`y-${i}`}>
                        <line x1={padding} y1={py} x2={width - padding} y2={py} stroke="#333" strokeWidth="1" />
                        <text x={padding - 10} y={py + 4} fill="#888" textAnchor="end" fontSize="12">10{<sup>{i}</sup>}</text>
                    </g>
                );
            }
        }

        // Data points (Staircase)
        let path = '';
        if (x.length === 2 && y.length === 1) {
            // Special case for single bin
            path = `M ${getX(x[0])} ${getY(y[0])} L ${getX(x[1])} ${getY(y[0])}`;
        } else {
            path = `M ${getX(x[0])} ${getY(y[0])}`;
            for (let i = 0; i < y.length; i++) {
                path += ` L ${getX(x[i+1])} ${getY(y[i])}`;
                if (i < y.length - 1) {
                    path += ` L ${getX(x[i+1])} ${getY(y[i+1])}`;
                }
            }
        }

        return (
            <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: '100%', userSelect: 'none' }}>
                {/* Background Grid */}
                {xTicks}
                {yTicks}

                {/* Axes */}
                <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#666" strokeWidth="2" />
                <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#666" strokeWidth="2" />
                
                {/* Data line */}
                <path d={path} fill="none" stroke="#007acc" strokeWidth="3" strokeLinejoin="round" />
                
                {/* Single point markers if few bins */}
                {y.length < 50 && y.map((val, i) => (
                    <circle key={i} cx={(getX(x[i]) + getX(x[i+1]))/2} cy={getY(val)} r="4" fill="#007acc" />
                ))}

                {/* Axis Labels */}
                <text x={width / 2} y={height - 10} fill="#fff" textAnchor="middle" fontSize="14" fontWeight="500">Energy [eV]</text>
                <text x={15} y={height / 2} fill="#fff" textAnchor="middle" fontSize="14" fontWeight="500" transform={`rotate(-90, 15, ${height / 2})`}>Tally Value [per src]</text>
            </svg>
        );
    }

    private renderSpatial(data: OpenMCSpatialPlotData): React.ReactNode {
        const x = data.positions;
        const y = data.values;
        if (!x || !y || x.length < 1) return <div style={{ color: '#f44336' }}>Invalid spatial data</div>;

        const width = 1000;
        const height = 500;
        const padding = 60;
        const plotWidth = width - 2 * padding;
        const plotHeight = height - 2 * padding;

        const minX = x[0];
        const maxX = x[x.length - 1];
        const getX = (val: number) => padding + (val - minX) / (maxX - minX) * plotWidth;

        let minY = 0; // Linear usually starts at 0
        let maxY = Math.max(...y);
        
        if (maxY === 0) maxY = 1;
        maxY = maxY * 1.1; // 10% headroom

        const getY = (val: number) => height - padding - (val - minY) / (maxY - minY) * plotHeight;

        // Grid lines (X)
        const xTicks = [];
        const nXTicks = 5;
        for (let i = 0; i <= nXTicks; i++) {
            const val = minX + i * (maxX - minX) / nXTicks;
            const px = getX(val);
            xTicks.push(
                <g key={`x-${i}`}>
                    <line x1={px} y1={padding} x2={px} y2={height - padding} stroke="#333" strokeWidth="1" />
                    <text x={px} y={height - padding + 20} fill="#888" textAnchor="middle" fontSize="12">{val.toFixed(1)}</text>
                </g>
            );
        }

        // Grid lines (Y)
        const yTicks = [];
        const nYTicks = 5;
        for (let i = 0; i <= nYTicks; i++) {
            const val = minY + i * (maxY - minY) / nYTicks;
            const py = getY(val);
            yTicks.push(
                <g key={`y-${i}`}>
                    <line x1={padding} y1={py} x2={width - padding} y2={py} stroke="#333" strokeWidth="1" />
                    <text x={padding - 10} y={py + 4} fill="#888" textAnchor="end" fontSize="12">{this.formatValue(val)}</text>
                </g>
            );
        }

        const points = x.map((val, i) => `${getX(val)},${getY(y[i])}`).join(' ');

        return (
            <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: '100%', userSelect: 'none' }}>
                {/* Background Grid */}
                {xTicks}
                {yTicks}

                {/* Axes */}
                <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#666" strokeWidth="2" />
                <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#666" strokeWidth="2" />
                
                {/* Data line */}
                <polyline points={points} fill="none" stroke="#4ec9b0" strokeWidth="3" strokeLinejoin="round" />
                
                {/* Points */}
                {x.length < 100 && x.map((val, i) => (
                    <circle key={i} cx={getX(val)} cy={getY(y[i])} r="3" fill="#4ec9b0" />
                ))}

                {/* Axis Labels */}
                <text x={width / 2} y={height - 10} fill="#fff" textAnchor="middle" fontSize="14" fontWeight="500">Position [cm]</text>
                <text x={15} y={height / 2} fill="#fff" textAnchor="middle" fontSize="14" fontWeight="500" transform={`rotate(-90, 15, ${height / 2})`}>Tally Value</text>
            </svg>
        );
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }
}
