// *****************************************************************************
// Copyright (C) 2026 NukeHub and others.
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
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { PlotlyComponent } from '../../../../plotly/plotly-component';
import {
    OpenMCBackendService,
    NCrystalInfoResult,
    NCrystalMaterialEntry,
    NCrystalMaterialsResult,
    NCrystalXSResult
} from '../../../../../common/openmc-protocol';
import { NC_CFG_FIELDS as CFG_FIELDS, composeCfgString } from './ncrystal-cfg';

export interface NCrystalTabProps {
    backendService: OpenMCBackendService;
    fileDialogService: FileDialogService;
}

/**
 * NCrystal tab of the Nuclear Data window: material list (NCrystal data
 * library or a custom .ncmat file), cfg-string builder with live preview +
 * copy, material detail, and a scatter/absorption XS plot (Plotly, log-log).
 */
export const NCrystalTab: React.FC<NCrystalTabProps> = ({ backendService, fileDialogService }) => {
    const [materials, setMaterials] = React.useState<NCrystalMaterialsResult | undefined>();
    const [materialsLoading, setMaterialsLoading] = React.useState(false);
    const [filter, setFilter] = React.useState('');
    const [baseMaterial, setBaseMaterial] = React.useState<string | undefined>();
    const [fields, setFields] = React.useState<Record<string, string>>({ temp: '300K' });
    const [info, setInfo] = React.useState<NCrystalInfoResult | undefined>();
    const [xs, setXs] = React.useState<NCrystalXSResult | undefined>();
    const [detailLoading, setDetailLoading] = React.useState(false);
    const [copied, setCopied] = React.useState(false);

    const cfg = baseMaterial ? composeCfgString(baseMaterial, fields) : undefined;

    const loadMaterials = React.useCallback(
        async (directory?: string) => {
            setMaterialsLoading(true);
            try {
                setMaterials(await backendService.getNCrystalMaterials({ directory }));
            } catch (error) {
                setMaterials({ success: false, error: String(error) });
            } finally {
                setMaterialsLoading(false);
            }
        },
        [backendService]
    );

    React.useEffect(() => {
        void loadMaterials();
    }, [loadMaterials]);

    const applyCfg = React.useCallback(
        async (cfgString: string) => {
            setDetailLoading(true);
            setInfo(undefined);
            setXs(undefined);
            try {
                const [infoResult, xsResult] = await Promise.all([
                    backendService.getNCrystalInfo({ cfg: cfgString }),
                    backendService.getNCrystalXS({ cfg: cfgString })
                ]);
                setInfo(infoResult);
                setXs(xsResult);
            } catch (error) {
                setInfo({ success: false, error: String(error) });
            } finally {
                setDetailLoading(false);
            }
        },
        [backendService]
    );

    const selectMaterial = (entry: NCrystalMaterialEntry): void => {
        setBaseMaterial(entry.name);
        setInfo(undefined);
        setXs(undefined);
    };

    const browseMaterialFile = async (): Promise<void> => {
        const props: OpenFileDialogProps = {
            title: 'Select .ncmat Material File',
            canSelectFiles: true,
            canSelectFolders: false,
            filters: { 'NCrystal Materials': ['ncmat'], 'All Files': ['*'] }
        };
        const uri = await fileDialogService.showOpenDialog(props);
        if (uri) {
            setBaseMaterial(uri.path.toString());
            setInfo(undefined);
            setXs(undefined);
        }
    };

    const browseMaterialDir = async (): Promise<void> => {
        const props: OpenFileDialogProps = {
            title: 'Select Directory with .ncmat Files',
            canSelectFiles: false,
            canSelectFolders: true
        };
        const uri = await fileDialogService.showOpenDialog(props);
        if (uri) {
            await loadMaterials(uri.path.toString());
        }
    };

    const copyCfg = (): void => {
        if (cfg) {
            void navigator.clipboard.writeText(cfg);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }
    };

    const filtered = (materials?.materials ?? []).filter((m) => m.name.toLowerCase().includes(filter.toLowerCase()));

    const xsPlot =
        xs?.success && xs.energies ? (
            <PlotlyComponent
                data={[
                    {
                        x: xs.energies,
                        y: xs.scatter,
                        mode: 'lines',
                        name: 'scatter',
                        line: { color: '#4a9eff', width: 2 }
                    },
                    {
                        x: xs.energies,
                        y: xs.absorption,
                        mode: 'lines',
                        name: 'absorption',
                        line: { color: '#f37524', width: 2 }
                    }
                ]}
                layout={{
                    margin: { l: 60, r: 20, t: 10, b: 45 },
                    xaxis: { type: 'log', title: { text: 'Energy [eV]' } },
                    yaxis: { type: 'log', title: { text: 'Cross section [barn]' } },
                    showlegend: true,
                    legend: { x: 0, y: 1 },
                    paper_bgcolor: 'rgba(0,0,0,0)',
                    plot_bgcolor: 'rgba(0,0,0,0)'
                }}
            />
        ) : undefined;

    return (
        <div className="ncrystal-tab">
            <div className="nuclide-list-panel">
                <div className="nuclide-toolbar">
                    <input
                        type="text"
                        placeholder={materials?.materialCount ? `Search ${materials.materialCount} materials…` : 'Search materials…'}
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                </div>
                <div className="ncrystal-toolbar-actions">
                    <Tooltip content="Load a single .ncmat file" position="bottom">
                        <button className="theia-button secondary" onClick={() => browseMaterialFile()}>
                            <i className="codicon codicon-file"></i> File…
                        </button>
                    </Tooltip>
                    <Tooltip content="List .ncmat files from a directory" position="bottom">
                        <button className="theia-button secondary" onClick={() => browseMaterialDir()}>
                            <i className="codicon codicon-folder-opened"></i> Dir…
                        </button>
                    </Tooltip>
                    <Tooltip content="Reload the material list" position="bottom">
                        <button className="theia-button secondary" disabled={materialsLoading} onClick={() => loadMaterials()}>
                            <i className="codicon codicon-refresh"></i>
                        </button>
                    </Tooltip>
                </div>
                {materialsLoading && (
                    <div className="empty-state">
                        <i className="codicon codicon-loading codicon-modifier-spin"></i>
                        <p>Listing materials…</p>
                    </div>
                )}
                {!materialsLoading && materials && !materials.success && (
                    <div className="empty-state">
                        <i className="codicon codicon-error"></i>
                        <p>{materials.error}</p>
                        <p className="empty-hint">NCrystal must be installed in the configured Python environment.</p>
                    </div>
                )}
                {!materialsLoading && materials?.success && (
                    <div className="nuclide-table-wrapper">
                        <table className="nuclide-table">
                            <thead>
                                <tr>
                                    <th>Material</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((m) => (
                                    <tr
                                        key={m.name}
                                        className={baseMaterial === m.name ? 'selected' : ''}
                                        onClick={() => selectMaterial(m)}
                                    >
                                        <td>{m.name}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {materials?.success && <div className="nuclide-list-footer">{materials.source}</div>}
            </div>

            <div className="nuclide-detail-panel">
                {!baseMaterial && (
                    <div className="empty-state">
                        <i className="codicon codicon-info"></i>
                        <p>Select a material or open a .ncmat file</p>
                    </div>
                )}
                {baseMaterial && (
                    <>
                        <div className="cfg-builder">
                            <div className="cfg-builder-fields">
                                {CFG_FIELDS.map((field) => (
                                    <label key={field.key} className="cfg-field">
                                        <span className="cfg-field-label">{field.label}</span>
                                        <input
                                            type="text"
                                            placeholder={field.placeholder}
                                            value={fields[field.key] ?? ''}
                                            onChange={(e) => setFields({ ...fields, [field.key]: e.target.value })}
                                        />
                                    </label>
                                ))}
                            </div>
                            <div className="cfg-preview-row">
                                <code className="cfg-preview">{cfg}</code>
                                <Tooltip content="Copy cfg string (paste into openmc-studio's NCrystal import)" position="bottom">
                                    <button className="theia-button secondary" onClick={copyCfg}>
                                        <i className={`codicon codicon-${copied ? 'check' : 'copy'}`}></i> {copied ? 'Copied' : 'Copy'}
                                    </button>
                                </Tooltip>
                                <button className="theia-button" disabled={detailLoading || !cfg} onClick={() => cfg && applyCfg(cfg)}>
                                    {detailLoading ? 'Loading…' : 'Apply'}
                                </button>
                            </div>
                            <div className="cfg-hints">
                                {CFG_FIELDS.map((field) => (
                                    <span key={field.key} className="cfg-hint">
                                        <strong>{field.label}:</strong> {field.hint}
                                    </span>
                                ))}
                            </div>
                        </div>

                        {info && !info.success && (
                            <div className="empty-state">
                                <i className="codicon codicon-error"></i>
                                <p>{info.error}</p>
                            </div>
                        )}

                        {info?.success && (
                            <div className="ncrystal-info">
                                <div className="detail-row">
                                    <span className="detail-label">Temperature:</span>
                                    <span>{info.temperature} K</span>
                                    <span className="detail-label" style={{ marginLeft: 16 }}>
                                        Density:
                                    </span>
                                    <span>{info.density?.toFixed(4)} g/cm³</span>
                                </div>
                                <div className="detail-row">
                                    <span className="detail-label">Composition:</span>
                                </div>
                                <div className="reaction-grid">
                                    {(info.composition ?? []).map((c) => (
                                        <Tooltip key={c.element} content={c.label} position="top">
                                            <span className="reaction-chip">
                                                {c.element} ×{c.fraction}
                                            </span>
                                        </Tooltip>
                                    ))}
                                </div>
                                {info.structure && (
                                    <div className="detail-row">
                                        <span className="detail-label">Structure:</span>
                                        <span>
                                            space group {info.structure.spacegroup}, a={info.structure.a} Å, volume{' '}
                                            {info.structure.volume?.toFixed(1)} Å³
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}

                        {xs?.success ? (
                            <div className="ncrystal-plot">{xsPlot}</div>
                        ) : (
                            xs && (
                                <div className="empty-state">
                                    <i className="codicon codicon-warning"></i>
                                    <p>{xs.error}</p>
                                </div>
                            )
                        )}
                    </>
                )}
            </div>
        </div>
    );
};
