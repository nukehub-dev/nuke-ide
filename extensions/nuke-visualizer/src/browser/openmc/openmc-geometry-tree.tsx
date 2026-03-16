// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { codicon } from '@theia/core/lib/browser/widgets/widget';
import { Message } from '@lumino/messaging';
import { Emitter, Event } from '@theia/core';
import { OpenMCService } from './openmc-service';
import { 
    OpenMCGeometryHierarchy, 
    OpenMCUniverse, 
    OpenMCCell, 
    OpenMCSurface,
    OpenMCLattice
} from '../../common/visualizer-protocol';
import { URI } from '@theia/core/lib/common/uri';
import './openmc-geometry-tree.css';

export interface GeometryView3DRequest {
    fileUri: URI;
    highlightCellId?: number;
}

export interface GeometryTreeSelection {
    type: 'universe' | 'cell' | 'surface' | 'lattice';
    id: number;
    parentId?: number;
}

@injectable()
export class OpenMCGeometryTreeWidget extends ReactWidget {
    static readonly ID = 'openmc-geometry-tree-widget';
    static readonly LABEL = 'OpenMC Geometry';

    @inject(OpenMCService)
    protected readonly openmcService!: OpenMCService;

    private geometryUri: URI | null = null;
    private hierarchy: OpenMCGeometryHierarchy | null = null;
    private selectedItem: GeometryTreeSelection | null = null;
    private expandedUniverses: Set<number> = new Set();
    private expandedCells: Set<string> = new Set();  // Format: "universeId:cellId"
    private showSurfaces: boolean = true;
    private filterText: string = '';

    private readonly _onGeometrySelected = new Emitter<GeometryTreeSelection>();
    readonly onGeometrySelected: Event<GeometryTreeSelection> = this._onGeometrySelected.event;

    private readonly _onView3D = new Emitter<GeometryView3DRequest>();
    readonly onView3D: Event<GeometryView3DRequest> = this._onView3D.event;

    @postConstruct()
    protected init(): void {
        this.id = OpenMCGeometryTreeWidget.ID;
        this.title.label = OpenMCGeometryTreeWidget.LABEL;
        this.title.caption = OpenMCGeometryTreeWidget.LABEL;
        this.title.iconClass = codicon('repo');
        this.title.closable = true;
        
        this.node.tabIndex = 0;
        this.update();
    }

    focus(): void {
        this.node.focus();
    }

    setGeometry(uri: URI, hierarchy: OpenMCGeometryHierarchy): void {
        this.geometryUri = uri;
        this.hierarchy = hierarchy;
        // Expand root universe by default
        if (hierarchy.rootUniverseId !== undefined) {
            this.expandedUniverses.add(hierarchy.rootUniverseId);
        }
        this.update();
    }

    protected render(): React.ReactNode {
        if (!this.hierarchy) {
            return (
                <div className="openmc-geometry-tree empty">
                    <div className="placeholder">
                        <i className={codicon('repo')}></i>
                        <div>Open a geometry file to view hierarchy</div>
                        <div className="placeholder-hint">Supported: geometry.xml, model directories</div>
                    </div>
                </div>
            );
        }

        const fileName = this.geometryUri?.path.base || 'Unknown';
        const filteredUniverses = this.getFilteredUniverses();

        return (
            <div className="openmc-geometry-tree">
                <div className="tree-header">
                    <div className="header-title">
                        <span className="file-name" title={fileName}>
                            <i className={codicon('repo')}></i>
                            {fileName}
                        </span>
                        <button 
                            className="close-btn" 
                            onClick={() => this.close()}
                            title="Close"
                        >
                            <i className={codicon('close')}></i>
                        </button>
                    </div>
                    <div className="geometry-stats">
                        {this.hierarchy.totalCells} cells, {this.hierarchy.totalSurfaces} surfaces
                    </div>
                    <div className="geometry-actions">
                        <button 
                            className="view-3d-btn"
                            onClick={() => this.viewIn3D()}
                            title="View Geometry in 3D"
                        >
                            <i className={codicon('globe')}></i>
                            View 3D
                        </button>
                    </div>
                    
                    {/* Search and filter */}
                    <div className="tree-toolbar">
                        <div className="search-box">
                            <i className={codicon('search')}></i>
                            <input
                                type="text"
                                placeholder="Filter cells, surfaces..."
                                value={this.filterText}
                                onChange={(e) => this.setFilterText(e.target.value)}
                            />
                            {this.filterText && (
                                <button 
                                    className="clear-search"
                                    onClick={() => this.setFilterText('')}
                                    title="Clear filter"
                                >
                                    <i className={codicon('close')}></i>
                                </button>
                            )}
                        </div>
                        <button
                            className={`toolbar-btn ${this.showSurfaces ? 'active' : ''}`}
                            onClick={() => this.toggleSurfaces()}
                            title="Toggle surfaces visibility"
                        >
                            <i className={codicon('symbol-misc')}></i>
                        </button>
                    </div>
                </div>
                
                <div className="tree-content">
                    {/* Root Universe Section */}
                    <div className="section-header">
                        <i className={codicon('globe')}></i>
                        <span>Universes</span>
                    </div>
                    {filteredUniverses.map(universe => this.renderUniverse(universe))}
                    
                    {/* Surfaces Section */}
                    {this.showSurfaces && this.hierarchy.surfaces.length > 0 && (
                        <>
                            <div className="section-header surfaces-header">
                                <i className={codicon('symbol-misc')}></i>
                                <span>Surfaces ({this.hierarchy.surfaces.length})</span>
                            </div>
                            <div className="surfaces-list">
                                {this.getFilteredSurfaces().map(surface => this.renderSurface(surface))}
                            </div>
                        </>
                    )}
                    
                    {/* Lattices Section */}
                    {this.hierarchy.lattices.length > 0 && (
                        <>
                            <div className="section-header lattices-header">
                                <i className={codicon('grid')}></i>
                                <span>Lattices ({this.hierarchy.lattices.length})</span>
                            </div>
                            {this.hierarchy.lattices.map(lattice => this.renderLattice(lattice))}
                        </>
                    )}
                </div>
            </div>
        );
    }

    private renderUniverse(universe: OpenMCUniverse): React.ReactNode {
        const isExpanded = this.expandedUniverses.has(universe.id);
        const isRoot = universe.isRoot || universe.id === this.hierarchy?.rootUniverseId;
        const isSelected = this.selectedItem?.type === 'universe' && this.selectedItem.id === universe.id;
        
        const filteredCells = this.getFilteredCells(universe.cells);
        
        return (
            <div 
                key={`universe-${universe.id}`} 
                className={`universe-item ${isRoot ? 'root-universe' : ''} ${isSelected ? 'selected' : ''}`}
            >
                <div 
                    className="universe-header"
                    onClick={() => this.selectUniverse(universe.id)}
                >
                    <button 
                        className="expand-btn"
                        onClick={(e) => { e.stopPropagation(); this.toggleUniverse(universe.id); }}
                    >
                        <i className={codicon(isExpanded ? 'chevron-down' : 'chevron-right')}></i>
                    </button>
                    <i className={codicon('globe')}></i>
                    <span className="universe-name">
                        {isRoot ? 'Root ' : ''}Universe {universe.id}
                    </span>
                    <span className="item-count">({universe.nCells} cells)</span>
                </div>
                
                {isExpanded && (
                    <div className="universe-cells">
                        {filteredCells.map(cell => this.renderCell(cell, universe.id))}
                    </div>
                )}
            </div>
        );
    }

    private renderCell(cell: OpenMCCell, universeId: number): React.ReactNode {
        const cellKey = `${universeId}:${cell.id}`;
        const isExpanded = this.expandedCells.has(cellKey);
        const isSelected = this.selectedItem?.type === 'cell' && this.selectedItem.id === cell.id;
        
        // Get icon based on fill type
        let icon = 'file';  // default
        if (cell.fillType === 'material') icon = 'symbol-color';
        else if (cell.fillType === 'universe') icon = 'globe';
        else if (cell.fillType === 'lattice') icon = 'grid';
        else if (cell.fillType === 'void') icon = 'empty-window';
        
        return (
            <div 
                key={cellKey}
                className={`cell-item ${isSelected ? 'selected' : ''}`}
            >
                <div 
                    className="cell-header"
                    onClick={() => this.selectCell(cell.id, universeId)}
                >
                    <button 
                        className="expand-btn"
                        onClick={(e) => { e.stopPropagation(); this.toggleCell(universeId, cell.id); }}
                    >
                        <i className={codicon(isExpanded ? 'chevron-down' : 'chevron-right')}></i>
                    </button>
                    <i className={codicon(icon)}></i>
                    <span className="cell-id">Cell {cell.id}</span>
                    {cell.name && <span className="cell-name">{cell.name}</span>}
                </div>
                
                {isExpanded && (
                    <div className="cell-details">
                        <div className="cell-actions">
                            <button 
                                className="highlight-btn"
                                onClick={(e) => { e.stopPropagation(); this.highlightCellIn3D(cell.id); }}
                                title={`Highlight Cell ${cell.id} in 3D View`}
                            >
                                <i className={codicon('eye')}></i>
                                Highlight in 3D
                            </button>
                        </div>
                        {cell.region && (
                            <div className="detail-row">
                                <span className="detail-label">Region:</span>
                                <code className="detail-value region-code">{cell.region}</code>
                            </div>
                        )}
                        <div className="detail-row">
                            <span className="detail-label">Fill:</span>
                            <span className="detail-value">
                                {cell.fillType === 'material' && cell.materialName 
                                    ? `${cell.materialName} (mat ${cell.fillId})`
                                    : cell.fillType === 'universe' 
                                        ? `Universe ${cell.fillId}`
                                        : cell.fillType === 'lattice'
                                            ? `Lattice ${cell.fillId}`
                                            : 'Void'
                                }
                            </span>
                        </div>
                        {cell.temperature && (
                            <div className="detail-row">
                                <span className="detail-label">Temperature:</span>
                                <span className="detail-value">{cell.temperature} K</span>
                            </div>
                        )}
                        {cell.density && (
                            <div className="detail-row">
                                <span className="detail-label">Density:</span>
                                <span className="detail-value">{cell.density} g/cm³</span>
                            </div>
                        )}
                        {cell.surfaces.length > 0 && (
                            <div className="detail-row surfaces-row">
                                <span className="detail-label">Surfaces:</span>
                                <div className="surface-badges">
                                    {cell.surfaces.map(sid => (
                                        <span key={sid} className="surface-badge">{sid}</span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        );
    }

    private renderSurface(surface: OpenMCSurface): React.ReactNode {
        const isSelected = this.selectedItem?.type === 'surface' && this.selectedItem.id === surface.id;
        
        // Get icon based on surface type
        let icon = 'circle-outline';
        if (surface.type.includes('cylinder')) icon = 'chrome-maximize';
        else if (surface.type.includes('plane')) icon = 'debug-breakline';
        else if (surface.type.includes('cone')) icon = 'triangle-up';
        else if (surface.type.includes('torus')) icon = 'refresh';
        
        return (
            <div 
                key={`surface-${surface.id}`}
                className={`surface-item ${isSelected ? 'selected' : ''}`}
                onClick={() => this.selectSurface(surface.id)}
                title={surface.description}
            >
                <i className={codicon(icon)}></i>
                <span className="surface-id">{surface.id}</span>
                <span className="surface-type">{surface.type}</span>
                {surface.boundary && surface.boundary !== 'transmission' && (
                    <span className={`boundary-badge ${surface.boundary}`}>{surface.boundary}</span>
                )}
            </div>
        );
    }

    private renderLattice(lattice: OpenMCLattice): React.ReactNode {
        const isSelected = this.selectedItem?.type === 'lattice' && this.selectedItem.id === lattice.id;
        
        return (
            <div 
                key={`lattice-${lattice.id}`}
                className={`lattice-item ${isSelected ? 'selected' : ''}`}
                onClick={() => this.selectLattice(lattice.id)}
            >
                <i className={codicon('grid')}></i>
                <span className="lattice-name">{lattice.name || `Lattice ${lattice.id}`}</span>
                <span className="lattice-type">{lattice.type}</span>
                <span className="item-count">({lattice.dimensions.join('×')})</span>
            </div>
        );
    }

    // === Filtering ===

    private getFilteredUniverses(): OpenMCUniverse[] {
        if (!this.hierarchy) return [];
        if (!this.filterText) return this.hierarchy.universes;
        
        const filter = this.filterText.toLowerCase();
        return this.hierarchy.universes.filter(u => {
            // Keep universe if any of its cells match
            return u.cells.some(c => this.cellMatchesFilter(c, filter));
        });
    }

    private getFilteredCells(cells: OpenMCCell[]): OpenMCCell[] {
        if (!this.filterText) return cells;
        return cells.filter(c => this.cellMatchesFilter(c, this.filterText.toLowerCase()));
    }

    private getFilteredSurfaces(): OpenMCSurface[] {
        if (!this.hierarchy) return [];
        if (!this.filterText) return this.hierarchy.surfaces;
        
        const filter = this.filterText.toLowerCase();
        return this.hierarchy.surfaces.filter(s => 
            s.id.toString().includes(filter) ||
            s.type.toLowerCase().includes(filter)
        );
    }

    private cellMatchesFilter(cell: OpenMCCell, filter: string): boolean {
        return (
            cell.id.toString().includes(filter) ||
            (cell.name?.toLowerCase().includes(filter) ?? false) ||
            (cell.materialName?.toLowerCase().includes(filter) ?? false) ||
            (cell.region?.toLowerCase().includes(filter) ?? false)
        );
    }

    // === Actions ===

    private setFilterText(text: string): void {
        this.filterText = text;
        this.update();
    }

    private toggleSurfaces(): void {
        this.showSurfaces = !this.showSurfaces;
        this.update();
    }

    private toggleUniverse(universeId: number): void {
        if (this.expandedUniverses.has(universeId)) {
            this.expandedUniverses.delete(universeId);
        } else {
            this.expandedUniverses.add(universeId);
        }
        this.update();
    }

    private toggleCell(universeId: number, cellId: number): void {
        const cellKey = `${universeId}:${cellId}`;
        if (this.expandedCells.has(cellKey)) {
            this.expandedCells.delete(cellKey);
        } else {
            this.expandedCells.add(cellKey);
        }
        this.update();
    }

    private selectUniverse(universeId: number): void {
        this.selectedItem = { type: 'universe', id: universeId };
        this._onGeometrySelected.fire(this.selectedItem);
        this.update();
    }

    private selectCell(cellId: number, universeId: number): void {
        this.selectedItem = { type: 'cell', id: cellId, parentId: universeId };
        this._onGeometrySelected.fire(this.selectedItem);
        this.update();
    }

    private selectSurface(surfaceId: number): void {
        this.selectedItem = { type: 'surface', id: surfaceId };
        this._onGeometrySelected.fire(this.selectedItem);
        this.update();
    }

    private selectLattice(latticeId: number): void {
        this.selectedItem = { type: 'lattice', id: latticeId };
        this._onGeometrySelected.fire(this.selectedItem);
        this.update();
    }

    private viewIn3D(): void {
        if (this.geometryUri) {
            this._onView3D.fire({ fileUri: this.geometryUri });
        }
    }

    private highlightCellIn3D(cellId: number): void {
        if (this.geometryUri) {
            this._onView3D.fire({ fileUri: this.geometryUri, highlightCellId: cellId });
        }
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }
}
