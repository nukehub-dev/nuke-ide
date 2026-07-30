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
import { injectable } from '@theia/core/shared/inversify';
import { Tooltip, ColorPicker } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCState, OpenMCMaterial } from '../../../../common/openmc-state-schema';
import { NCRYSTAL_PACKAGES } from '../../../../common/packages';
import type { SimulationDashboardWidget } from '../simulation-dashboard-widget';
import { DashboardTabContribution } from './tab-registry';

/**
 * Materials tab of the simulation dashboard: material list and creation/editing form.
 */
@injectable()
export class MaterialsTabContribution implements DashboardTabContribution {
    readonly id = 'materials';
    readonly label = 'Materials';
    readonly icon = 'symbol-color';
    readonly order = 1;

    /** Whether the material creation/editing form is currently shown. */
    private showNewMaterialForm = false;
    /** Material currently being edited, or undefined when creating a new material. */
    private editingMaterial?: OpenMCMaterial;

    // Form state for new material
    private newMaterialName = '';
    private newMaterialDensity = 1.0;
    private newMaterialDensityUnit: OpenMCMaterial['densityUnit'] = 'g/cm3';
    private newMaterialNuclides: { name: string; fraction: number; fractionType: 'ao' | 'wo' }[] = [];
    private newMaterialIsDepletable = false;
    private newMaterialVolume?: number;
    private newMaterialTemperature?: number;
    private newMaterialThermalScattering: { name: string; fraction: number }[] = [];
    private newMaterialColor = '#4A90D9';

    /** Material type for the creation form. */
    private newMaterialType: 'nuclides' | 'macroscopic' = 'nuclides';
    /** Macroscopic XS data set name (multigroup materials). */
    private newMaterialMacroscopicName = '';
    /** NCrystal configuration string for the import action. */
    private ncrystalCfg = '';
    /** NCrystal availability (undefined = not yet checked). */
    private ncrystalAvailable?: boolean;
    /** Whether the NCrystal availability check has been started. */
    private ncrystalCheckStarted = false;
    /** Whether an NCrystal import is in progress. */
    private ncrystalImporting = false;

    // Material templates
    private readonly MATERIAL_TEMPLATES: { name: string; description: string; setup: () => void }[] = [
        {
            name: 'UO2 Fuel (4% enriched)',
            description: 'Uranium dioxide fuel with 4% U-235 enrichment',
            setup: () => {
                this.newMaterialName = 'UO2 Fuel';
                this.newMaterialDensity = 10.0;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'U235', fraction: 0.04, fractionType: 'wo' },
                    { name: 'U238', fraction: 0.96, fractionType: 'wo' },
                    { name: 'O16', fraction: 2.0, fractionType: 'wo' }
                ];
                this.newMaterialIsDepletable = true;
                this.newMaterialColor = '#FF6B35';
            }
        },
        {
            name: 'Light Water (H2O)',
            description: 'Light water moderator with thermal scattering',
            setup: () => {
                this.newMaterialName = 'Water';
                this.newMaterialDensity = 1.0;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'H1', fraction: 2.0, fractionType: 'ao' },
                    { name: 'O16', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialThermalScattering = [{ name: 'c_H_in_H2O', fraction: 1.0 }];
                this.newMaterialColor = '#4ECDC4';
            }
        },
        {
            name: 'Heavy Water (D2O)',
            description: 'Heavy water moderator',
            setup: () => {
                this.newMaterialName = 'Heavy Water';
                this.newMaterialDensity = 1.1;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'H2', fraction: 2.0, fractionType: 'ao' },
                    { name: 'O16', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialThermalScattering = [{ name: 'c_D_in_D2O', fraction: 1.0 }];
                this.newMaterialColor = '#95E1D3';
            }
        },
        {
            name: 'Graphite',
            description: 'Graphite moderator/reflector',
            setup: () => {
                this.newMaterialName = 'Graphite';
                this.newMaterialDensity = 1.7;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [{ name: 'C0', fraction: 1.0, fractionType: 'ao' }];
                this.newMaterialThermalScattering = [{ name: 'c_Graphite', fraction: 1.0 }];
                this.newMaterialColor = '#2C3E50';
            }
        },
        {
            name: 'Stainless Steel 304',
            description: 'Common structural material',
            setup: () => {
                this.newMaterialName = 'SS304';
                this.newMaterialDensity = 8.0;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'Fe56', fraction: 0.7, fractionType: 'wo' },
                    { name: 'Cr52', fraction: 0.2, fractionType: 'wo' },
                    { name: 'Ni58', fraction: 0.1, fractionType: 'wo' }
                ];
                this.newMaterialColor = '#95A5A6';
            }
        },
        {
            name: 'Boron Carbide (B4C)',
            description: 'Control rod material',
            setup: () => {
                this.newMaterialName = 'B4C';
                this.newMaterialDensity = 2.5;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'B10', fraction: 4.0, fractionType: 'ao' },
                    { name: 'C0', fraction: 1.0, fractionType: 'ao' }
                ];
                this.newMaterialColor = '#8E44AD';
            }
        },
        {
            name: 'Air/Vacuum',
            description: 'Void material',
            setup: () => {
                this.newMaterialName = 'Air';
                this.newMaterialDensity = 0.001;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [
                    { name: 'N14', fraction: 0.8, fractionType: 'ao' },
                    { name: 'O16', fraction: 0.2, fractionType: 'ao' }
                ];
                this.newMaterialColor = '#ECF0F1';
            }
        },
        {
            name: 'Helium (Coolant)',
            description: 'Helium gas coolant',
            setup: () => {
                this.newMaterialName = 'Helium';
                this.newMaterialDensity = 0.00018;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = [{ name: 'He4', fraction: 1.0, fractionType: 'ao' }];
                this.newMaterialColor = '#F39C12';
            }
        }
    ];

    /**
     * Render the Materials tab with list and creation form.
     * @param host - Simulation dashboard widget host.
     * @param state - Current OpenMC simulation state.
     * @returns Materials tab React node.
     */
    render(host: SimulationDashboardWidget, state: OpenMCState): React.ReactNode {
        // Get DAGMC materials from fileInfo if available
        const dagmcMaterials = state.settings.dagmcFile ? this.getDAGMCMaterialsFromState(state) || {} : {};
        const hasDagmcMaterials = Object.keys(dagmcMaterials).length > 0;

        return (
            <div className="materials-tab">
                {/* DAGMC Materials Section */}
                {hasDagmcMaterials && (
                    <div className="dagmc-materials-panel">
                        <div className="dagmc-panel-header">
                            <h4>
                                <i className="codicon codicon-file-code"></i> DAGMC Materials
                            </h4>
                            <span className="dagmc-badge">From {state.settings.dagmcFile?.split('/').pop()}</span>
                        </div>
                        <p className="dagmc-panel-description">
                            These materials are defined in the DAGMC geometry file. You should create matching materials below for OpenMC to
                            use.
                        </p>
                        <div className="dagmc-materials-grid">
                            {Object.entries(dagmcMaterials).map(([name, data]) => (
                                <div key={name} className="dagmc-material-card">
                                    <div className="dagmc-mat-name">{name}</div>
                                    <div className="dagmc-mat-stats">
                                        {data.volumeCount} volume{(data.volumeCount || 0) !== 1 ? 's' : ''},{' '}
                                        {(data.totalTriangles || 0).toLocaleString()} triangles
                                    </div>
                                    {/* Check if matching material exists */}
                                    {state.materials.some((m) => m.name.toLowerCase() === name.toLowerCase()) ? (
                                        <span className="dagmc-mat-status matched">
                                            <i className="codicon codicon-check"></i> Matched
                                        </span>
                                    ) : (
                                        <span className="dagmc-mat-status missing">
                                            <i className="codicon codicon-warning"></i> No match
                                        </span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Instructions */}
                {!hasDagmcMaterials && (
                    <div className="instructions-panel">
                        <h4>
                            <i className="codicon codicon-lightbulb"></i> How to Create Materials
                        </h4>
                        <div className="instruction-steps">
                            <div className="step">
                                <span className="step-number">1</span>
                                <span>Enter a name and density for your material</span>
                            </div>
                            <div className="step">
                                <span className="step-number">2</span>
                                <span>Add nuclides (e.g., U235, O16) with fractions</span>
                            </div>
                            <div className="step">
                                <span className="step-number">3</span>
                                <span>For depletion: Check "Depletable" and enter volume</span>
                            </div>
                            <div className="step">
                                <span className="step-number">4</span>
                                <span>For moderators: Add S(α,β) thermal scattering data</span>
                            </div>
                        </div>
                    </div>
                )}

                <div className="materials-toolbar">
                    <button
                        className="theia-button primary"
                        onClick={() => {
                            this.showNewMaterialForm = true;
                            this.editingMaterial = undefined;
                            this.resetNewMaterialForm();
                            host.update();
                        }}
                    >
                        <i className="codicon codicon-add"></i> Add Material
                    </button>
                </div>

                {this.showNewMaterialForm && (
                    <div className="material-form-container">
                        <h4>{this.editingMaterial ? 'Edit Material' : 'New Material'}</h4>
                        {this.renderMaterialForm(host)}
                    </div>
                )}

                <div className="materials-list">
                    {state.materials.length === 0 && !hasDagmcMaterials ? (
                        <div className="empty-state">
                            <i className="codicon codicon-info"></i>
                            <p>No materials defined. Click "Add Material" to create your first material.</p>
                        </div>
                    ) : state.materials.length === 0 && hasDagmcMaterials ? (
                        <div className="empty-state dagmc-info">
                            <i className="codicon codicon-file-code"></i>
                            <p>No OpenMC materials defined yet.</p>
                            <p className="empty-hint">
                                DAGMC geometry has {Object.keys(dagmcMaterials).length} material(s). Create matching materials above.
                            </p>
                        </div>
                    ) : (
                        state.materials.map((material) => (
                            <div
                                key={material.id}
                                className="material-card"
                                style={{ borderLeft: `4px solid ${material.color || '#4A90D9'}` }}
                            >
                                <div className="material-card-header">
                                    <div className="material-info">
                                        <span className="material-id">#{material.id}</span>
                                        <span className="material-name">{material.name}</span>
                                        {material.isDepletable && (
                                            <Tooltip content="Depletable material" position="top">
                                                <span className="depletable-badge">
                                                    <i className="codicon codicon-history"></i>
                                                </span>
                                            </Tooltip>
                                        )}
                                        {material.thermalScattering && material.thermalScattering.length > 0 && (
                                            <Tooltip content="Has thermal scattering" position="top">
                                                <span className="thermal-badge">
                                                    <i className="codicon codicon-flame"></i>
                                                </span>
                                            </Tooltip>
                                        )}
                                    </div>
                                    <div className="material-actions">
                                        <Tooltip content="Duplicate Material" position="top">
                                            <button
                                                className="theia-button secondary small"
                                                onClick={() => this.duplicateMaterial(host, material)}
                                            >
                                                <i className="codicon codicon-copy"></i>
                                            </button>
                                        </Tooltip>
                                        <Tooltip content="Edit Material" position="top">
                                            <button
                                                className="theia-button secondary small"
                                                onClick={() => this.editMaterial(host, material)}
                                            >
                                                <i className="codicon codicon-edit"></i>
                                            </button>
                                        </Tooltip>
                                        <Tooltip content="Delete Material" position="top">
                                            <button
                                                className="theia-button secondary small danger"
                                                onClick={() => this.deleteMaterial(host, material.id)}
                                            >
                                                <i className="codicon codicon-trash"></i>
                                            </button>
                                        </Tooltip>
                                    </div>
                                </div>
                                <div className="material-card-body">
                                    <div className="material-property">
                                        <label>Density:</label>
                                        <span>
                                            {material.density.toFixed(4)} {material.densityUnit}
                                        </span>
                                    </div>
                                    <div className="material-property">
                                        <label>Nuclides:</label>
                                        <span>{material.nuclides.length}</span>
                                    </div>
                                    {material.temperature && (
                                        <div className="material-property">
                                            <label>Temperature:</label>
                                            <span>{material.temperature} K</span>
                                        </div>
                                    )}
                                </div>
                                <div className="material-nuclides-preview">
                                    {material.nuclides.slice(0, 5).map((n) => (
                                        <span key={n.name} className="nuclide-tag">
                                            {n.name}: {n.fraction.toExponential(2)} {n.fractionType}
                                        </span>
                                    ))}
                                    {material.nuclides.length > 5 && (
                                        <span className="nuclide-tag more">+{material.nuclides.length - 5} more</span>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        );
    }

    /**
     * Render the material creation/editing form with templates.
     * @returns Material form React node.
     * @param host - Simulation dashboard widget host.
     */
    private renderMaterialForm(host: SimulationDashboardWidget): React.ReactNode {
        return (
            <div className="material-form">
                {/* Template Selector */}
                {!this.editingMaterial && (
                    <div className="form-group template-selector">
                        <label>
                            <i className="codicon codicon-symbol-snippet"></i> Start from Template (Optional)
                        </label>
                        <select
                            value=""
                            onChange={(e) => {
                                const template = this.MATERIAL_TEMPLATES.find((t) => t.name === e.target.value);
                                if (template) {
                                    template.setup();
                                    host.update();
                                }
                                e.target.value = '';
                            }}
                        >
                            <option value="">Select a template...</option>
                            {this.MATERIAL_TEMPLATES.map((template) => (
                                <option key={template.name} value={template.name}>
                                    {template.name} - {template.description}
                                </option>
                            ))}
                        </select>
                    </div>
                )}

                <div className="form-row">
                    <div className="form-group">
                        <label>Material Type</label>
                        <select
                            value={this.newMaterialType}
                            onChange={(e) => {
                                this.newMaterialType = e.target.value as 'nuclides' | 'macroscopic';
                                host.update();
                            }}
                        >
                            <option value="nuclides">Nuclide Mixture</option>
                            <option value="macroscopic">Macroscopic (Multigroup)</option>
                        </select>
                        {this.newMaterialType === 'macroscopic' && (
                            <span className="form-hint">
                                Requires multi-group energy mode and an MGXS library (generation comes in a later phase)
                            </span>
                        )}
                    </div>
                </div>

                {this.newMaterialType === 'macroscopic' && (
                    <div className="form-row">
                        <div className="form-group">
                            <label>XS Data Name</label>
                            <input
                                type="text"
                                value={this.newMaterialMacroscopicName}
                                placeholder="e.g., UO2"
                                onChange={(e) => {
                                    this.newMaterialMacroscopicName = e.target.value;
                                    host.update();
                                }}
                            />
                            <span className="form-hint">Name of the macroscopic data set in the MGXS library</span>
                        </div>
                    </div>
                )}

                {this.newMaterialType === 'nuclides' && !this.editingMaterial && this.renderNCrystalImport(host)}

                <div className="form-row">
                    <div className="form-group">
                        <label>Name</label>
                        <input
                            type="text"
                            value={this.newMaterialName}
                            onChange={(e) => {
                                this.newMaterialName = e.target.value;
                                host.update();
                            }}
                            placeholder="e.g., UO2 Fuel"
                        />
                    </div>
                    <div className="form-group color-picker-group">
                        <label>
                            Color <span className="color-value">{this.newMaterialColor}</span>
                        </label>
                        <ColorPicker
                            value={this.newMaterialColor}
                            onChange={(color) => {
                                this.newMaterialColor = color;
                                host.update();
                            }}
                        />
                    </div>
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Density Unit</label>
                        <select
                            value={this.newMaterialDensityUnit}
                            onChange={(e) => {
                                this.newMaterialDensityUnit = e.target.value as OpenMCMaterial['densityUnit'];
                                host.update();
                            }}
                        >
                            <option value="g/cm3">g/cm³</option>
                            <option value="kg/m3">kg/m³</option>
                            <option value="atom/b-cm">atom/b-cm</option>
                            <option value="sum">Sum</option>
                        </select>
                    </div>
                </div>

                {this.newMaterialDensityUnit !== 'sum' && (
                    <div className="form-group">
                        <label>Density</label>
                        <input
                            type="number"
                            step="0.01"
                            value={this.newMaterialDensity}
                            onChange={(e) => {
                                this.newMaterialDensity = parseFloat(e.target.value) || 0;
                                host.update();
                            }}
                        />
                    </div>
                )}

                {/* Depletable Material Options */}
                <div className="form-section-title">Depletion Options</div>
                <div className="depletion-section">
                    <div className="depletion-toggle">
                        <label className="toggle-label">
                            <input
                                type="checkbox"
                                checked={this.newMaterialIsDepletable}
                                onChange={(e) => {
                                    this.newMaterialIsDepletable = e.target.checked;
                                    host.update();
                                }}
                            />
                            <span className="toggle-text">Depletable Material</span>
                        </label>
                        <span className="depletion-description">Enable for burnup/depletion calculations</span>
                    </div>
                    {this.newMaterialIsDepletable && (
                        <div className="depletion-fields">
                            <div className="form-group">
                                <label>
                                    Volume (cm³) <span className="required">*</span>
                                </label>
                                <input
                                    type="number"
                                    step="0.1"
                                    value={this.newMaterialVolume || ''}
                                    onChange={(e) => {
                                        this.newMaterialVolume = e.target.value ? parseFloat(e.target.value) : undefined;
                                        host.update();
                                    }}
                                    placeholder="Required for depletion"
                                />
                                <span className="form-hint">Material volume for burnup calculations</span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="form-row">
                    <div className="form-group">
                        <label>Temperature (K, optional)</label>
                        <input
                            type="number"
                            step="1"
                            value={this.newMaterialTemperature || ''}
                            onChange={(e) => {
                                this.newMaterialTemperature = e.target.value ? parseFloat(e.target.value) : undefined;
                                host.update();
                            }}
                            placeholder="e.g., 600"
                        />
                        <span className="form-hint">For Doppler broadening</span>
                    </div>
                </div>

                {/* Thermal Scattering */}
                {this.newMaterialType === 'nuclides' && (
                    <div className="nuclides-section thermal-section">
                        <h5>
                            <i className="codicon codicon-flame"></i>
                            Thermal Scattering (S(α,β))
                            <span className="optional-badge">Optional</span>
                        </h5>
                        <span className="section-hint">Add thermal scattering data for moderators like water, graphite</span>
                        {this.newMaterialThermalScattering.map((sab, index) => (
                            <div key={index} className="nuclide-row">
                                <input
                                    type="text"
                                    placeholder="e.g., c_Graphite or h_H2O"
                                    value={sab.name}
                                    onChange={(e) => {
                                        this.newMaterialThermalScattering[index].name = e.target.value;
                                        host.update();
                                    }}
                                />
                                <input
                                    type="number"
                                    step="0.1"
                                    placeholder="Fraction"
                                    value={sab.fraction}
                                    onChange={(e) => {
                                        this.newMaterialThermalScattering[index].fraction = parseFloat(e.target.value) || 1.0;
                                        host.update();
                                    }}
                                />
                                <Tooltip content="Remove" position="top">
                                    <button
                                        className="theia-button secondary small"
                                        onClick={() => {
                                            this.newMaterialThermalScattering.splice(index, 1);
                                            host.update();
                                        }}
                                    >
                                        <i className="codicon codicon-trash"></i>
                                    </button>
                                </Tooltip>
                            </div>
                        ))}
                        <Tooltip content="Add thermal scattering data" position="right">
                            <button
                                className="theia-button secondary small"
                                onClick={() => {
                                    this.newMaterialThermalScattering.push({ name: '', fraction: 1.0 });
                                    host.update();
                                }}
                            >
                                <i className="codicon codicon-add"></i> Add S(α,β)
                            </button>
                        </Tooltip>
                    </div>
                )}

                {this.newMaterialType === 'nuclides' && (
                    <div className="nuclides-section">
                        <h5>Nuclides</h5>
                        {this.newMaterialNuclides.map((nuclide, index) => (
                            <div key={index} className="nuclide-row">
                                <input
                                    type="text"
                                    placeholder="e.g., U235"
                                    value={nuclide.name}
                                    onChange={(e) => {
                                        this.newMaterialNuclides[index].name = e.target.value;
                                        host.update();
                                    }}
                                />
                                <input
                                    type="number"
                                    step="0.0001"
                                    placeholder="Fraction"
                                    value={nuclide.fraction}
                                    onChange={(e) => {
                                        this.newMaterialNuclides[index].fraction = parseFloat(e.target.value) || 0;
                                        host.update();
                                    }}
                                />
                                <select
                                    value={nuclide.fractionType}
                                    onChange={(e) => {
                                        this.newMaterialNuclides[index].fractionType = e.target.value as 'ao' | 'wo';
                                        host.update();
                                    }}
                                >
                                    <option value="ao">ao (atom)</option>
                                    <option value="wo">wo (weight)</option>
                                </select>
                                <Tooltip content="Remove Nuclide" position="top">
                                    <button
                                        className="theia-button secondary small"
                                        onClick={() => {
                                            this.newMaterialNuclides.splice(index, 1);
                                            host.update();
                                        }}
                                    >
                                        <i className="codicon codicon-trash"></i>
                                    </button>
                                </Tooltip>
                            </div>
                        ))}
                        <Tooltip content="Add Nuclide" position="right">
                            <button
                                className="theia-button secondary small"
                                onClick={() => {
                                    this.newMaterialNuclides.push({ name: '', fraction: 1.0, fractionType: 'ao' });
                                    host.update();
                                }}
                            >
                                <i className="codicon codicon-add"></i> Add Nuclide
                            </button>
                        </Tooltip>
                    </div>
                )}

                <div className="form-actions">
                    <button className="theia-button primary" onClick={() => this.saveMaterial(host)}>
                        {this.editingMaterial ? 'Update Material' : 'Create Material'}
                    </button>
                    <button
                        className="theia-button secondary"
                        onClick={() => {
                            this.showNewMaterialForm = false;
                            this.editingMaterial = undefined;
                            host.update();
                        }}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    /**
     * Reset the new material form fields to defaults.
     */
    private resetNewMaterialForm(): void {
        this.newMaterialName = '';
        this.newMaterialDensity = 1.0;
        this.newMaterialDensityUnit = 'g/cm3';
        this.newMaterialNuclides = [];
        this.newMaterialIsDepletable = false;
        this.newMaterialVolume = undefined;
        this.newMaterialTemperature = undefined;
        this.newMaterialThermalScattering = [];
        this.newMaterialColor = '#4A90D9';
        this.newMaterialType = 'nuclides';
        this.newMaterialMacroscopicName = '';
        this.ncrystalCfg = '';
    }

    /**
     * Start the lazy NCrystal availability check (runs once per tab instance).
     * @param host - Simulation dashboard widget host.
     */
    private checkNCrystalAvailability(host: SimulationDashboardWidget): void {
        if (this.ncrystalCheckStarted) {
            return;
        }
        this.ncrystalCheckStarted = true;
        host.nukeCoreService
            .detectPythonWithRequirements({ requiredPackages: NCRYSTAL_PACKAGES, searchWorkspaceVenvs: true })
            .then((result) => {
                this.ncrystalAvailable = result.success;
                host.update();
            })
            .catch(() => {
                this.ncrystalAvailable = false;
                host.update();
            });
    }

    /**
     * Import a material composition from an NCrystal configuration string.
     * @param host - Simulation dashboard widget host.
     */
    private async importFromNCrystal(host: SimulationDashboardWidget): Promise<void> {
        const cfg = this.ncrystalCfg.trim();
        if (!cfg) {
            return;
        }
        this.ncrystalImporting = true;
        host.update();
        try {
            const result = await host.studioService.getBackendService().importNCrystalMaterial(cfg);
            if (result.success && result.material) {
                this.newMaterialType = 'nuclides';
                this.newMaterialName = cfg.split(';')[0].replace(/\.ncmat$/, '');
                this.newMaterialDensity = result.material.density;
                this.newMaterialDensityUnit = 'g/cm3';
                this.newMaterialNuclides = result.material.nuclides.map((n) => ({ ...n }));
                this.newMaterialTemperature = result.material.temperature ?? undefined;
                host.messageService.info(`NCrystal material imported (${result.material.nuclides.length} nuclides)`);
            } else {
                host.messageService.error(result.error || 'NCrystal import failed');
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            host.messageService.error(`NCrystal import failed: ${msg}`);
        } finally {
            this.ncrystalImporting = false;
            host.update();
        }
    }

    /**
     * Render the NCrystal import row (hidden/disabled when NCrystal is unavailable).
     * @param host - Simulation dashboard widget host.
     * @returns NCrystal import row React node.
     */
    private renderNCrystalImport(host: SimulationDashboardWidget): React.ReactNode {
        this.checkNCrystalAvailability(host);
        const available = this.ncrystalAvailable === true;
        const tooltip =
            this.ncrystalAvailable === undefined
                ? 'Checking NCrystal availability...'
                : available
                  ? 'Import material composition via NCrystal'
                  : 'NCrystal is not available in the detected Python environment';

        return (
            <div className="form-group">
                <label>
                    <i className="codicon codicon-cloud-download"></i> Import from NCrystal (Optional)
                </label>
                <div className="file-input-group">
                    <input
                        type="text"
                        value={this.ncrystalCfg}
                        placeholder="e.g., Al_sg225.ncmat;temp=300K"
                        onChange={(e) => {
                            this.ncrystalCfg = e.target.value;
                            host.update();
                        }}
                    />
                    <Tooltip content={tooltip} position="top">
                        <button
                            className="theia-button secondary"
                            disabled={!available || this.ncrystalImporting || !this.ncrystalCfg.trim()}
                            onClick={() => this.importFromNCrystal(host)}
                        >
                            <i className="codicon codicon-cloud-download"></i>
                            {this.ncrystalImporting ? 'Importing...' : 'Import'}
                        </button>
                    </Tooltip>
                </div>
                <span className="form-hint">Fills the form with the NCrystal composition; review and click Create</span>
            </div>
        );
    }

    /**
     * Enter material editing mode with the given material's values.
     * @param host - Simulation dashboard widget host.
     * @param material - Material to edit.
     */
    private editMaterial(host: SimulationDashboardWidget, material: OpenMCMaterial): void {
        this.editingMaterial = material;
        this.newMaterialName = material.name;
        this.newMaterialDensity = material.density;
        this.newMaterialDensityUnit = material.densityUnit;
        this.newMaterialNuclides = [...material.nuclides.map((n) => ({ ...n }))];
        this.newMaterialIsDepletable = material.isDepletable || false;
        this.newMaterialVolume = material.volume;
        this.newMaterialTemperature = material.temperature;
        this.newMaterialThermalScattering = material.thermalScattering?.map((s) => ({ ...s })) || [];
        this.newMaterialColor = material.color || '#4A90D9';
        this.newMaterialType = material.macroscopic ? 'macroscopic' : 'nuclides';
        this.newMaterialMacroscopicName = material.macroscopic?.name ?? '';
        this.showNewMaterialForm = true;
        host.update();
    }

    /**
     * Extract DAGMC material information from the current state.
     * @param state - Current OpenMC simulation state.
     * @returns Record of material names to usage stats, or undefined.
     */
    private getDAGMCMaterialsFromState(state: OpenMCState): Record<string, { volumeCount: number; totalTriangles: number }> | undefined {
        // Get DAGMC info from settings (set by CSGBuilder when importing DAGMC file)
        const dagmcInfo = state.settings.dagmcInfo;
        if (dagmcInfo?.materials) {
            return dagmcInfo.materials;
        }
        return undefined;
    }

    /**
     * Duplicate a material and open the creation form pre-filled.
     * @param host - Simulation dashboard widget host.
     * @param material - Material to duplicate.
     */
    private duplicateMaterial(host: SimulationDashboardWidget, material: OpenMCMaterial): void {
        this.editingMaterial = undefined;
        this.newMaterialName = `${material.name} (Copy)`;
        this.newMaterialDensity = material.density;
        this.newMaterialDensityUnit = material.densityUnit;
        this.newMaterialNuclides = [...material.nuclides.map((n) => ({ ...n }))];
        this.newMaterialIsDepletable = material.isDepletable || false;
        this.newMaterialVolume = material.volume;
        this.newMaterialTemperature = material.temperature;
        this.newMaterialThermalScattering = material.thermalScattering?.map((s) => ({ ...s })) || [];
        this.newMaterialColor = material.color || '#4A90D9';
        this.newMaterialType = material.macroscopic ? 'macroscopic' : 'nuclides';
        this.newMaterialMacroscopicName = material.macroscopic?.name ?? '';
        this.showNewMaterialForm = true;
        host.update();
        host.messageService.info('Edit the duplicated material and click Create');
    }

    /**
     * Delete a material by id.
     * @param host - Simulation dashboard widget host.
     * @param id - Material id to delete.
     */
    private deleteMaterial(host: SimulationDashboardWidget, id: number): void {
        host.stateManager.removeMaterial(id);
        host.messageService.info('Material deleted');
    }

    /**
     * Save the current material form (create new or update existing).
     * @param host - Simulation dashboard widget host.
     */
    private saveMaterial(host: SimulationDashboardWidget): void {
        if (!this.newMaterialName.trim()) {
            host.messageService.error('Material name is required');
            return;
        }

        // Macroscopic (multigroup) material: no nuclide decomposition required
        if (this.newMaterialType === 'macroscopic') {
            if (!this.newMaterialMacroscopicName.trim()) {
                host.messageService.error('XS data name is required for macroscopic materials');
                return;
            }

            const macroscopicMaterial: OpenMCMaterial = {
                id: this.editingMaterial?.id || host.stateManager.getNextMaterialId(),
                name: this.newMaterialName.trim(),
                density: this.newMaterialDensity,
                densityUnit: this.newMaterialDensityUnit,
                nuclides: [],
                thermalScattering: [],
                macroscopic: { name: this.newMaterialMacroscopicName.trim() },
                isDepletable: this.newMaterialIsDepletable,
                volume: this.newMaterialVolume,
                temperature: this.newMaterialTemperature,
                color: this.newMaterialColor
            };

            if (this.editingMaterial) {
                host.stateManager.updateMaterial(this.editingMaterial.id, macroscopicMaterial);
                host.messageService.info('Material updated');
            } else {
                host.stateManager.addMaterial(macroscopicMaterial);
                host.messageService.info('Material created');
            }

            this.showNewMaterialForm = false;
            this.editingMaterial = undefined;
            this.resetNewMaterialForm();
            return;
        }

        if (this.newMaterialNuclides.length === 0) {
            host.messageService.error('At least one nuclide is required');
            return;
        }

        // Filter out empty nuclides
        const validNuclides = this.newMaterialNuclides.filter((n) => n.name.trim() !== '');
        if (validNuclides.length === 0) {
            host.messageService.error('At least one valid nuclide is required');
            return;
        }

        // Validate depletable material has volume
        if (this.newMaterialIsDepletable && !this.newMaterialVolume) {
            host.messageService.error('Depletable materials require a volume');
            return;
        }

        const material: OpenMCMaterial = {
            id: this.editingMaterial?.id || host.stateManager.getNextMaterialId(),
            name: this.newMaterialName.trim(),
            density: this.newMaterialDensity,
            densityUnit: this.newMaterialDensityUnit,
            nuclides: validNuclides.map((n) => ({
                name: n.name.trim(),
                fraction: n.fraction,
                fractionType: n.fractionType
            })),
            thermalScattering: this.newMaterialThermalScattering
                .filter((sab) => sab.name.trim() !== '')
                .map((sab) => ({
                    name: sab.name.trim(),
                    fraction: sab.fraction
                })),
            isDepletable: this.newMaterialIsDepletable,
            volume: this.newMaterialVolume,
            temperature: this.newMaterialTemperature,
            color: this.newMaterialColor
        };

        if (this.editingMaterial) {
            host.stateManager.updateMaterial(this.editingMaterial.id, material);
            host.messageService.info('Material updated');
        } else {
            host.stateManager.addMaterial(material);
            host.messageService.info('Material created');
        }

        this.showNewMaterialForm = false;
        this.editingMaterial = undefined;
        this.resetNewMaterialForm();
    }
}
