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

import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import './openmc-material-explorer.css';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { MessageService } from '@theia/core/lib/common/message-service';
import URI from '@theia/core/lib/common/uri';
import { OpenMCService } from './openmc-service';
import { OpenMCMaterial, OpenMCMaterialNuclide } from '../../common/visualizer-protocol';

@injectable()
export class OpenMCMaterialExplorerWidget extends ReactWidget {
    static readonly ID = 'openmc-material-explorer';
    static readonly LABEL = 'OpenMC Material Explorer';

    @inject(MessageService)
    protected readonly messageService!: MessageService;

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    private materials: OpenMCMaterial[] = [];
    private selectedMaterial: OpenMCMaterial | null = null;
    private searchQuery = '';
    private isLoading = false;
    private error: string | null = null;
    private fileUri: URI | null = null;
    private sortBy: 'id' | 'name' | 'density' = 'id';
    private sortAsc = true;
    private materialCells: { [materialId: string]: Array<{ id: number; name: string; universe: number }> } = {};
    private geometryUri: URI | null = null;
    private linkedCells: Array<{ id: number; name: string; universe: number }> = [];

    @postConstruct()
    protected init(): void {
        this.id = OpenMCMaterialExplorerWidget.ID;
        this.title.label = OpenMCMaterialExplorerWidget.LABEL;
        this.title.caption = OpenMCMaterialExplorerWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-flask';
        this.update();
    }

    setFileUri(uri: URI): void {
        this.fileUri = uri;
        this.title.label = `Materials: ${uri.path.base}`;
        // Look for geometry.xml in the same directory
        this.geometryUri = uri.parent.resolve('geometry.xml');
        this.loadMaterials();
    }

    private async loadMaterials(): Promise<void> {
        if (!this.fileUri) {
            return;
        }

        this.isLoading = true;
        this.error = null;
        this.update();

        try {
            const result = await this.openmcService.getMaterials(this.fileUri);
            if (result.error) {
                this.error = result.error;
                this.materials = [];
            } else {
                this.materials = result.materials || [];
                // Select first material by default
                if (this.materials.length > 0 && !this.selectedMaterial) {
                    this.selectedMaterial = this.materials[0];
                }
                // Load cell linkage if geometry.xml exists
                await this.loadCellLinkage();
                // Update linked cells for selected material
                if (this.selectedMaterial) {
                    this.linkedCells = this.materialCells[this.selectedMaterial.id.toString()] || [];
                }
            }
        } catch (err) {
            this.error = err instanceof Error ? err.message : String(err);
            this.materials = [];
        } finally {
            this.isLoading = false;
            this.update();
        }
    }
    
    private async loadCellLinkage(): Promise<void> {
        if (!this.fileUri || !this.geometryUri) {
            return;
        }
        
        try {
            // Check if geometry.xml exists
            const exists = await this.openmcService.checkFileExists(this.geometryUri);
            if (!exists) {
                return;
            }
            
            const result = await this.openmcService.getMaterialCellLinkage(this.fileUri, this.geometryUri);
            if (!result.error) {
                this.materialCells = result.linkage || {};
                // Update linked cells for currently selected material
                if (this.selectedMaterial) {
                    this.linkedCells = this.materialCells[this.selectedMaterial.id.toString()] || [];
                }
            }
        } catch (err) {
            console.log('[MaterialExplorer] Could not load cell linkage:', err);
        }
    }

    private getFilteredMaterials(): OpenMCMaterial[] {
        let filtered = this.materials;

        if (this.searchQuery) {
            const query = this.searchQuery.toLowerCase();
            filtered = filtered.filter(m =>
                m.name.toLowerCase().includes(query) ||
                m.id.toString().includes(query) ||
                m.nuclides.some(n => n.name.toLowerCase().includes(query))
            );
        }

        // Sort
        filtered = [...filtered].sort((a, b) => {
            let comparison = 0;
            switch (this.sortBy) {
                case 'id':
                    comparison = a.id - b.id;
                    break;
                case 'name':
                    comparison = a.name.localeCompare(b.name);
                    break;
                case 'density':
                    comparison = a.density - b.density;
                    break;
            }
            return this.sortAsc ? comparison : -comparison;
        });

        return filtered;
    }

    private handleSort(by: 'id' | 'name' | 'density'): void {
        if (this.sortBy === by) {
            this.sortAsc = !this.sortAsc;
        } else {
            this.sortBy = by;
            this.sortAsc = true;
        }
        this.update();
    }

    private async highlightCell(cellId: number): Promise<void> {
        if (!this.geometryUri) {
            this.messageService.warn('No geometry.xml found. Cannot highlight cell.');
            return;
        }
        
        try {
            // Check if geometry file exists
            const exists = await this.openmcService.checkFileExists(this.geometryUri);
            if (!exists) {
                this.messageService.warn('geometry.xml not found.');
                return;
            }
            
            // Open the geometry viewer with the cell highlighted
            const widget = await this.openmcService.openGeometryViewer(this.geometryUri, cellId);
            
            if (!widget) {
                this.messageService.error('Failed to open Geometry Viewer');
            }
            // Widget is automatically opened and activated by openGeometryViewer
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.messageService.error(`Failed to highlight cell: ${msg}`);
        }
    }

    private renderToolbar(): React.ReactNode {
        return (
            <div className='material-explorer-toolbar'>
                <div className='search-box'>
                    <i className='fa fa-search'></i>
                    <input
                        type='text'
                        placeholder='Search materials or nuclides...'
                        value={this.searchQuery}
                        onChange={e => {
                            this.searchQuery = e.target.value;
                            this.update();
                        }}
                    />
                </div>
                <div className='stats'>
                    <span><i className='fa fa-cubes'></i> {this.materials.length} Materials</span>
                    <span><i className='fa fa-atom'></i> {this.materials.reduce((sum, m) => sum + m.nuclides.length, 0)} Nuclides</span>
                    {this.materials.some(m => m.isDepletable) && (
                        <span className='depletable-stat'><i className='fa fa-fire'></i> {this.materials.filter(m => m.isDepletable).length} Depletable</span>
                    )}
                </div>
            </div>
        );
    }

    private renderMaterialList(): React.ReactNode {
        const filtered = this.getFilteredMaterials();

        return (
            <div className='material-list'>
                <div className='material-list-header'>
                    <div
                        className={`sortable ${this.sortBy === 'id' ? 'active' : ''}`}
                        onClick={() => this.handleSort('id')}
                    >
                        ID {this.sortBy === 'id' && <i className={`fa fa-sort-${this.sortAsc ? 'asc' : 'desc'}`}></i>}
                    </div>
                    <div
                        className={`sortable ${this.sortBy === 'name' ? 'active' : ''}`}
                        onClick={() => this.handleSort('name')}
                    >
                        Name {this.sortBy === 'name' && <i className={`fa fa-sort-${this.sortAsc ? 'asc' : 'desc'}`}></i>}
                    </div>
                    <div
                        className={`sortable ${this.sortBy === 'density' ? 'active' : ''}`}
                        onClick={() => this.handleSort('density')}
                    >
                        Density {this.sortBy === 'density' && <i className={`fa fa-sort-${this.sortAsc ? 'asc' : 'desc'}`}></i>}
                    </div>
                </div>
                <div className='material-list-body'>
                    {filtered.map(material => (
                        <div
                            key={material.id}
                            className={`material-item ${this.selectedMaterial?.id === material.id ? 'selected' : ''}`}
                            onClick={() => {
                                this.selectedMaterial = material;
                                // Update linked cells for selected material
                                this.linkedCells = this.materialCells[material.id.toString()] || [];
                                this.update();
                            }}
                        >
                            <div className='material-id'>#{material.id}</div>
                            <div className='material-info'>
                                <div className='material-name'>
                                    {material.name || `Material ${material.id}`}
                                    {material.isDepletable && <span className='depletable-badge' title='Depletable material'>D</span>}
                                </div>
                                <div className='material-meta'>
                                    {material.nuclides.length} nuclides
                                    {material.thermalScattering.length > 0 && ` • ${material.thermalScattering.length} S(α,β)`}
                                </div>
                            </div>
                            <div className='material-density'>
                                {material.density > 0 ? `${material.density.toFixed(3)}` : '—'}
                                <span className='density-unit'>{material.densityUnit}</span>
                            </div>
                        </div>
                    ))}
                    {filtered.length === 0 && (
                        <div className='no-results'>No materials found</div>
                    )}
                </div>
            </div>
        );
    }

    private renderNuclideBarChart(nuclides: OpenMCMaterialNuclide[]): React.ReactNode {
        if (nuclides.length === 0) return null;

        const maxFraction = Math.max(...nuclides.map(n => n.fraction));

        return (
            <div className='nuclide-chart'>
                <h4>Nuclide Composition</h4>
                {nuclides.map(nuclide => {
                    const percentage = (nuclide.fraction / maxFraction) * 100;
                    return (
                        <div key={nuclide.name} className='nuclide-bar-row'>
                            <div className='nuclide-name'>{nuclide.name}</div>
                            <div className='nuclide-bar-container'>
                                <div
                                    className='nuclide-bar'
                                    style={{ width: `${percentage}%` }}
                                    title={`${nuclide.fraction.toFixed(6)} ${nuclide.fractionType}`}
                                ></div>
                            </div>
                            <div className='nuclide-fraction'>
                                {nuclide.fraction.toFixed(6)} {nuclide.fractionType}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }

    private renderCellLinkageSection(): React.ReactNode {
        if (!this.selectedMaterial) return null;

        return (
            <div className='cell-linkage-section'>
                <h4>📦 Cell Usage
                    {this.linkedCells.length > 0 && (
                        <span className='cell-count-badge'>{this.linkedCells.length}</span>
                    )}
                </h4>
                {this.linkedCells.length === 0 ? (
                    <div className='no-cells-message'>
                        {this.geometryUri ? (
                            <span>No cells found using this material</span>
                        ) : (
                            <span className='geometry-not-found'>
                                <i className='fa fa-info-circle'></i>
                                {' '}Open geometry.xml to see cell usage
                            </span>
                        )}
                    </div>
                ) : (
                    <div className='cell-list'>
                        {this.linkedCells.map(cell => (
                            <div key={cell.id} className='cell-item'>
                                <div className='cell-info'>
                                    <span className='cell-id'>#{cell.id}</span>
                                    <span className='cell-name' title={cell.name}>
                                        {cell.name}
                                    </span>
                                    <span className='cell-universe'>U:{cell.universe}</span>
                                </div>
                                <button
                                    className='cell-highlight-btn'
                                    title='Highlight cell in Geometry Viewer'
                                    onClick={() => this.highlightCell(cell.id)}
                                >
                                    <i className='fa fa-crosshairs'></i>
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    private renderMaterialDetails(): React.ReactNode {
        if (!this.selectedMaterial) {
            return (
                <div className='material-details empty'>
                    <i className='fa fa-flask'></i>
                    <p>Select a material to view details</p>
                </div>
            );
        }

        const m = this.selectedMaterial;

        return (
            <div className='material-details'>
                <div className='material-header'>
                    <h3>{m.name || `Material ${m.id}`}</h3>
                    <div className='material-badges'>
                        {m.isDepletable && <span className='badge depletable'>Depletable</span>}
                        {m.thermalScattering.length > 0 && (
                            <span className='badge thermal'>S(α,β): {m.thermalScattering.length}</span>
                        )}
                    </div>
                </div>

                <div className='properties-grid'>
                    <div className='property'>
                        <label>ID</label>
                        <span className='property-value'>{m.id}</span>
                    </div>
                    <div className='property'>
                        <label>Density</label>
                        <span className='property-value'>
                            {m.density > 0 ? `${m.density.toFixed(6)} ${m.densityUnit}` : m.densityUnit}
                        </span>
                    </div>
                    {m.temperature && (
                        <div className='property'>
                            <label>Temperature</label>
                            <span className='property-value'>{m.temperature} K</span>
                        </div>
                    )}
                    {m.volume && (
                        <div className='property'>
                            <label>Volume</label>
                            <span className='property-value'>{m.volume.toExponential(4)} cm³</span>
                        </div>
                    )}
                    <div className='property'>
                        <label>Nuclides</label>
                        <span className='property-value'>{m.nuclides.length}</span>
                    </div>
                </div>

                {m.thermalScattering.length > 0 && (
                    <div className='thermal-scattering-section'>
                        <h4>Thermal Scattering (S(α,β))</h4>
                        <div className='thermal-list'>
                            {m.thermalScattering.map(ts => (
                                <div key={ts.name} className='thermal-item'>
                                    <span className='thermal-name'>{ts.name}</span>
                                    <span className='thermal-fraction'>{ts.fraction}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {this.renderCellLinkageSection()}

                {this.renderNuclideBarChart(m.nuclides)}

                <div className='nuclide-table-section'>
                    <h4>Nuclide Table</h4>
                    <table className='nuclide-table'>
                        <thead>
                            <tr>
                                <th>Nuclide</th>
                                <th>Fraction</th>
                                <th>Type</th>
                            </tr>
                        </thead>
                        <tbody>
                            {m.nuclides.map(n => (
                                <tr key={n.name}>
                                    <td>{n.name}</td>
                                    <td>{n.fraction.toExponential(6)}</td>
                                    <td>{n.fractionType === 'wo' ? 'Weight %' : 'Atom %'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        );
    }

    render(): React.ReactNode {
        if (this.isLoading) {
            return (
                <div className='material-explorer-container loading'>
                    <i className='fa fa-spinner fa-spin'></i>
                    <p>Loading materials...</p>
                </div>
            );
        }

        if (this.error) {
            return (
                <div className='material-explorer-container error'>
                    <i className='fa fa-exclamation-triangle'></i>
                    <p>Error loading materials:</p>
                    <p className='error-message'>{this.error}</p>
                </div>
            );
        }

        return (
            <div className='material-explorer-container'>
                {this.renderToolbar()}
                <div className='material-explorer-content'>
                    <div className='material-list-panel'>
                        {this.renderMaterialList()}
                    </div>
                    <div className='material-details-panel'>
                        {this.renderMaterialDetails()}
                    </div>
                </div>
            </div>
        );
    }
}
