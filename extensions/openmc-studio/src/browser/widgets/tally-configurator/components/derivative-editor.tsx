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
import { NukeSelect } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCMaterial, OpenMCTallyDerivative } from '../../../../common/openmc-state-schema';

/**
 * Props for the {@link DerivativeEditor} component.
 */
interface DerivativeEditorProps {
    /** The tally's derivative (undefined when none is set) */
    derivative?: OpenMCTallyDerivative;
    /** Materials available as perturbation domains */
    materials: OpenMCMaterial[];
    /** Callback when the derivative changes (undefined clears it) */
    onUpdate: (derivative: OpenMCTallyDerivative | undefined) => void;
}

/**
 * Editor for a tally's material perturbation derivative
 * (openmc.TallyDerivative): perturbed variable, material domain, and nuclide
 * for nuclide_density derivatives. A tally carries at most one derivative.
 *
 * @see {@link TallyEditor}
 */
export const DerivativeEditor: React.FC<DerivativeEditorProps> = ({ derivative, materials, onUpdate }) => {
    const update = (updates: Partial<OpenMCTallyDerivative>): void => {
        if (derivative) {
            onUpdate({ ...derivative, ...updates });
        }
    };

    if (!derivative) {
        return (
            <div className="derivative-editor">
                <button
                    className="add-button"
                    disabled={materials.length === 0}
                    onClick={() => onUpdate({ variable: 'density', materialId: materials[0]?.id ?? 1 })}
                >
                    <i className="codicon codicon-add"></i> Add Derivative
                </button>
                {materials.length === 0 && <p className="form-hint">Define materials first — the derivative perturbs a material.</p>}
            </div>
        );
    }

    const domainMaterial = materials.find((m) => m.id === derivative.materialId);

    return (
        <div className="derivative-editor">
            <div className="form-row">
                <div className="form-group">
                    <label>Variable</label>
                    <NukeSelect
                        value={derivative.variable}
                        options={[
                            { value: 'density', label: 'Density' },
                            { value: 'nuclide_density', label: 'Nuclide Density' },
                            { value: 'temperature', label: 'Temperature' }
                        ]}
                        onChange={(value: string) => update({ variable: value as OpenMCTallyDerivative['variable'], nuclide: undefined })}
                        ariaLabel="Derivative variable"
                    />
                </div>
                <div className="form-group">
                    <label>Perturbed Material</label>
                    <NukeSelect
                        value={String(derivative.materialId)}
                        options={[...materials.map((mat) => ({ value: String(mat.id), label: mat.name || `Material ${mat.id}` }))]}
                        onChange={(value: string) => update({ materialId: parseInt(value), nuclide: undefined })}
                        ariaLabel="Perturbed material"
                    />
                </div>
                {derivative.variable === 'nuclide_density' && (
                    <div className="form-group">
                        <label>Perturbed Nuclide</label>
                        <NukeSelect
                            value={derivative.nuclide ?? ''}
                            options={[
                                { value: '', label: '-- Select nuclide --' },
                                ...(domainMaterial?.nuclides ?? []).map((nuc) => ({ value: nuc.name, label: nuc.name }))
                            ]}
                            onChange={(value: string) => update({ nuclide: value || undefined })}
                            ariaLabel="Perturbed nuclide"
                        />
                    </div>
                )}
                <div className="form-group">
                    <label>&nbsp;</label>
                    <button className="remove-filter-btn" onClick={() => onUpdate(undefined)}>
                        <i className="codicon codicon-trash"></i>
                    </button>
                </div>
            </div>
            {derivative.variable === 'temperature' && (
                <p className="form-hint">Temperature derivatives require the perturbed material's temperature to be set.</p>
            )}
            {derivative.variable === 'nuclide_density' && !derivative.nuclide && (
                <p className="validation-warning">
                    <i className="codicon codicon-warning"></i> Select a nuclide — required for nuclide_density derivatives.
                </p>
            )}
        </div>
    );
};
