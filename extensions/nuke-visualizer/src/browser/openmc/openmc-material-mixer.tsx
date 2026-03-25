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
import { OpenMCMaterial } from '../../common/visualizer-protocol';
import { OpenMCService } from './openmc-service';
import './openmc-material-mixer.css';

export interface OpenMCMaterialMixerProps {
    materials: OpenMCMaterial[];
    filePath: string;
    openmcService: OpenMCService;
    onClose: () => void;
    onMaterialAdded?: () => void;
}

export const OpenMCMaterialMixer: React.FC<OpenMCMaterialMixerProps> = ({
    materials,
    filePath,
    openmcService,
    onClose,
    onMaterialAdded
}) => {
    const [searchQuery, setSearchQuery] = React.useState('');
    const [selectedMats, setSelectedMats] = React.useState<Array<{ material: OpenMCMaterial; fraction: number }>>([]);
    const [percentType, setPercentType] = React.useState<'ao' | 'wo' | 'vo'>('ao');
    const [newName, setNewName] = React.useState('Mixed Material');
    const [newId, setNewId] = React.useState<number>(999);
    const [isMixing, setIsMixing] = React.useState(false);
    const [isSaving, setIsSaving] = React.useState(false);
    const [result, setResult] = React.useState<any | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [savedMessage, setSavedMessage] = React.useState<string | null>(null);
    const resultRef = React.useRef<HTMLDivElement>(null);

    // Auto-scroll to result when it's generated
    React.useEffect(() => {
        if (result && resultRef.current) {
            // Small delay to ensure DOM is updated
            setTimeout(() => {
                resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }, 100);
        }
    }, [result]);

    const filteredMaterials = materials.filter(m =>
        m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.id.toString().includes(searchQuery)
    );

    const addMaterial = (mat: OpenMCMaterial) => {
        if (selectedMats.some(s => s.material.id === mat.id)) return;
        setSelectedMats([...selectedMats, { material: mat, fraction: 0.0 }]);
    };

    const removeMaterial = (id: number) => {
        setSelectedMats(selectedMats.filter(s => s.material.id !== id));
    };

    const updateFraction = (id: number, val: string) => {
        const fraction = parseFloat(val) || 0.0;
        setSelectedMats(selectedMats.map(s =>
            s.material.id === id ? { ...s, fraction } : s
        ));
    };

    const handleMix = async () => {
        setIsMixing(true);
        setError(null);
        setResult(null);
        setSavedMessage(null);

        try {
            const request = {
                filePath,
                materialIds: selectedMats.map(s => s.material.id),
                fractions: selectedMats.map(s => s.fraction),
                percentType,
                name: newName,
                id: newId
            };

            const response = await openmcService.mixMaterials(request);
            if (response.error) {
                setError(response.error);
            } else {
                setResult(response.material);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsMixing(false);
        }
    };

    const handleSaveToFile = async () => {
        if (!result?.xml) return;

        setIsSaving(true);
        setSavedMessage(null);
        setError(null);

        try {
            await openmcService.addMaterialToFile(filePath, result.xml);
            setSavedMessage(`Material '${result.name}' (ID ${result.id}) added to materials.xml`);
            if (onMaterialAdded) {
                onMaterialAdded();
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsSaving(false);
        }
    };

    const totalFraction = selectedMats.reduce((sum, s) => sum + s.fraction, 0);
    const isValid = selectedMats.length >= 2 && (percentType === 'vo' || Math.abs(totalFraction - 1.0) < 1e-6);

    return (
        <div className='material-mixer-modal-overlay' onClick={onClose}>
            <div className='material-mixer-modal' onClick={e => e.stopPropagation()}>
                <div className='material-mixer-header'>
                    <h3><i className='fa fa-blender'></i> Material Homogenizer</h3>
                    <div className='header-actions'>
                        {result && (
                            <button 
                                className='header-btn'
                                onClick={handleSaveToFile}
                                disabled={isSaving}
                                title='Save to materials.xml'
                            >
                                {isSaving ? <i className='fa fa-spinner fa-spin'></i> : <i className='fa fa-save'></i>}
                                {isSaving ? 'Saving...' : 'Save to File'}
                            </button>
                        )}
                        <button className='close-btn' onClick={onClose} title='Close mixer'>
                            <i className='fa fa-times'></i>
                        </button>
                    </div>
                </div>

                <div className='material-mixer-content'>
                    {/* Left Panel: Source Library */}
                    <aside className='material-mixer-source-panel'>
                        <h4>Source Materials</h4>
                        <div className='material-mixer-search-container'>
                            <div className='material-mixer-search'>
                                <i className='fa fa-search'></i>
                                <input
                                    type='text'
                                    placeholder='Search materials...'
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                />
                            </div>
                        </div>
                        <div className='material-mixer-available-list'>
                            {filteredMaterials.map(m => (
                                <div
                                    key={m.id}
                                    className='material-mixer-available-item'
                                    onClick={() => addMaterial(m)}
                                    title={`Add ${m.name || `Material ${m.id}`} to mixture`}
                                >
                                    <span className='mat-id'>#{m.id}</span>
                                    <span className='mat-name'>
                                        {m.name || `Material ${m.id}`}
                                        {m.thermalScattering && m.thermalScattering.length > 0 && (
                                            <i className='fa fa-thermometer-half' style={{ marginLeft: '8px', color: '#e67e22' }} title='Contains S(a,b) data'></i>
                                        )}
                                    </span>
                                    <i className='fa fa-plus-circle'></i>
                                </div>
                            ))}
                        </div>
                    </aside>

                    {/* Right Panel: Main Content */}
                    <main className='material-mixer-main-panel'>
                        <div className='material-mixer-scroll-area'>
                            {/* Fraction Type */}
                            <div className='material-mixer-section'>
                                <div className='material-mixer-section-title'>
                                    <i className='fa fa-cog'></i> Fraction Type
                                </div>
                                <div className='material-mixer-type-selector'>
                                    <label className={`material-mixer-type-option ${percentType === 'ao' ? 'active' : ''}`}>
                                        <input type='radio' name='percentType' checked={percentType === 'ao'} onChange={() => setPercentType('ao')} />
                                        Atom % (ao)
                                    </label>
                                    <label className={`material-mixer-type-option ${percentType === 'wo' ? 'active' : ''}`}>
                                        <input type='radio' name='percentType' checked={percentType === 'wo'} onChange={() => setPercentType('wo')} />
                                        Weight % (wo)
                                    </label>
                                    <label className={`material-mixer-type-option ${percentType === 'vo' ? 'active' : ''}`}>
                                        <input type='radio' name='percentType' checked={percentType === 'vo'} onChange={() => setPercentType('vo')} />
                                        Volume % (vo)
                                    </label>
                                </div>
                            </div>

                            {/* Selected Components */}
                            <div className='material-mixer-section'>
                                <div className='material-mixer-section-title'>
                                    <i className='fa fa-list-ul'></i> Selected Components
                                </div>
                                <div className='material-mixer-mix-list'>
                                    {selectedMats.map(s => (
                                        <div key={s.material.id} className='material-mixer-mix-item'>
                                            <div className='mat-info'>
                                                <div className='mat-name' title={s.material.name || `Material ${s.material.id}`}>
                                                    {s.material.name || `Material ${s.material.id}`}
                                                </div>
                                                <div className='mat-density'>{s.material.density.toFixed(4)} {s.material.densityUnit}</div>
                                            </div>
                                            <div className='fraction-input-wrapper'>
                                                <input
                                                    type='number'
                                                    step='0.001'
                                                    min='0'
                                                    max='1'
                                                    value={s.fraction}
                                                    onChange={e => updateFraction(s.material.id, e.target.value)}
                                                />
                                            </div>
                                            <button className='remove-btn' onClick={() => removeMaterial(s.material.id)} title='Remove'>
                                                <i className='fa fa-trash'></i>
                                            </button>
                                        </div>
                                    ))}
                                    {selectedMats.length === 0 && (
                                        <div className='no-results' style={{ padding: '30px', border: '2px dashed var(--theia-panel-border)', borderRadius: '8px', textAlign: 'center', fontSize: '13px', color: 'var(--theia-description-foreground)' }}>
                                            <i className='fa fa-arrow-left' style={{ marginRight: '8px' }}></i> 
                                            Select materials from the library to begin
                                        </div>
                                    )}
                                </div>
                            </div>

                            {selectedMats.length > 0 && (
                                <div className={`material-mixer-validation ${isValid ? 'valid' : 'invalid'}`}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                        <i className={`status-icon fa fa-${isValid ? 'check-circle' : 'exclamation-circle'}`}></i>
                                        <span>
                                            {percentType === 'vo'
                                                ? `Volume Total: ${totalFraction.toFixed(4)}${totalFraction < 1.0 ? ' (remainder will be void)' : ''}`
                                                : `Fraction Sum: ${totalFraction.toFixed(4)} / 1.0000`}
                                        </span>
                                    </div>
                                    {!isValid && percentType !== 'vo' && <span>Must equal 1.0</span>}
                                </div>
                            )}

                            {/* Metadata */}
                            <div className='material-mixer-section'>
                                <div className='material-mixer-section-title'>
                                    <i className='fa fa-tag'></i> Output Properties
                                </div>
                                <div className='material-mixer-metadata'>
                                    <div className='material-mixer-field'>
                                        <label>Material Name</label>
                                        <input type='text' value={newName} onChange={e => setNewName(e.target.value)} placeholder='e.g. MOX Fuel' />
                                    </div>
                                    <div className='material-mixer-field'>
                                        <label>Material ID</label>
                                        <input type='number' value={newId} onChange={e => setNewId(parseInt(e.target.value) || 0)} />
                                    </div>
                                </div>
                            </div>

                            {/* Warnings for S(a,b) */}
                            {result?.warnings && result.warnings.length > 0 && (
                                <div className='material-mixer-warnings'>
                                    <div className='material-mixer-warnings-title'>
                                        <i className='fa fa-exclamation-triangle'></i>
                                        Thermal Scattering Notice
                                    </div>
                                    <ul className='material-mixer-warnings-list'>
                                        {result.warnings.map((w: string, i: number) => (
                                            <li key={i}>{w}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {/* Result Card */}
                            {result && (
                                <div className='material-mixer-result-card' ref={resultRef}>
                                    <div className='material-mixer-result-header'>
                                        <span><i className='fa fa-check-circle'></i> Generated Material</span>
                                        <button 
                                            className='header-btn'
                                            onClick={() => navigator.clipboard.writeText(result.xml)}
                                            title='Copy XML to clipboard'
                                        >
                                            <i className='fa fa-copy'></i> Copy XML
                                        </button>
                                    </div>
                                    <div className='material-mixer-result-body'>
                                        <div className='material-mixer-stats-grid'>
                                            <div className='material-mixer-stat-item'>
                                                <label>Density</label>
                                                <span>{result.density.toFixed(6)} {result.densityUnit}</span>
                                            </div>
                                            <div className='material-mixer-stat-item'>
                                                <label>Nuclides</label>
                                                <span>{result.totalNuclides}</span>
                                            </div>
                                            <div className='material-mixer-stat-item'>
                                                <label>Depletable</label>
                                                <span>{result.isDepletable ? 'Yes' : 'No'}</span>
                                            </div>
                                        </div>
                                        <div className='material-mixer-xml-box'>
                                            {result.xml}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {savedMessage && (
                                <div className='material-mixer-success-message'>
                                    <i className='fa fa-check-circle'></i>
                                    {savedMessage}
                                </div>
                            )}
                        </div>
                    </main>
                </div>

                {error && (
                    <div className='material-mixer-error-banner'>
                        <i className='fa fa-exclamation-triangle'></i>
                        <span>{error}</span>
                    </div>
                )}

                <div className='material-mixer-footer'>
                    <button className='material-mixer-btn material-mixer-btn-secondary' onClick={onClose}>Cancel</button>
                    <button
                        className='material-mixer-btn material-mixer-btn-primary'
                        disabled={!isValid || isMixing}
                        onClick={handleMix}
                    >
                        {isMixing ? <i className='fa fa-sync fa-spin'></i> : <i className='fa fa-cogs'></i>}
                        {isMixing ? 'Calculating Mixture...' : 'Generate Mixture'}
                    </button>
                </div>
            </div>
        </div>
    );
};
