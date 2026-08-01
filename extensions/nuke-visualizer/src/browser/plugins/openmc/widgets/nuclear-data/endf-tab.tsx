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
import {
    OpenMCBackendService,
    EndfDetailResult,
    EndfEvaluationsResult,
    EndfNuclideEntry,
    EndfSublibrary
} from '../../../../../common/openmc-protocol';
import { formatEnergyEeV, formatHalfLife, formatYield } from './endf-format';

export interface EndfTabProps {
    backendService: OpenMCBackendService;
    fileDialogService: FileDialogService;
    /** ENDF library dir from the `nuke.endfLibrary` preference (survives sessions). */
    initialDir?: string;
    /** Called when the user picks a new directory — the parent persists it to the preference. */
    onDirChange?: (dir: string) => void;
}

/** Session-persisted ENDF library directory (fallback before the preference loads). */
let lastEndfDir = '';

/**
 * ENDF tab of the Nuclear Data window: scan an ENDF library directory
 * (decay / nfy / sfy / neutrons sub-libraries), pick a nuclide, and inspect
 * the evaluation — decay table, fission-yield table, or reaction sections.
 */
export const EndfTab: React.FC<EndfTabProps> = ({ backendService, fileDialogService, initialDir, onDirChange }) => {
    const [directory, setDirectory] = React.useState(initialDir || lastEndfDir);
    const [evaluations, setEvaluations] = React.useState<EndfEvaluationsResult | undefined>();
    const [listLoading, setListLoading] = React.useState(false);
    const [sublib, setSublib] = React.useState<EndfSublibrary | undefined>();
    const [filter, setFilter] = React.useState('');
    const [selected, setSelected] = React.useState<EndfNuclideEntry | undefined>();
    const [detail, setDetail] = React.useState<EndfDetailResult | undefined>();
    const [detailLoading, setDetailLoading] = React.useState(false);
    const [energyIndex, setEnergyIndex] = React.useState(0);

    const load = React.useCallback(
        async (dir: string) => {
            if (!dir) {
                return;
            }
            setListLoading(true);
            setEvaluations(undefined);
            setSublib(undefined);
            setSelected(undefined);
            setDetail(undefined);
            try {
                const result = await backendService.getEndfEvaluations({ directory: dir });
                setEvaluations(result);
                if (result.success && result.sublibraries?.length) {
                    // Prefer the neutrons sub-library when present
                    const preferred = result.sublibraries.find((s) => s.name === 'neutrons') ?? result.sublibraries[0];
                    setSublib(preferred);
                }
            } catch (error) {
                setEvaluations({ success: false, error: String(error) });
            } finally {
                setListLoading(false);
            }
        },
        [backendService]
    );

    React.useEffect(() => {
        if (initialDir && initialDir !== lastEndfDir) {
            lastEndfDir = initialDir;
            setDirectory(initialDir);
            void load(initialDir);
        } else if (lastEndfDir) {
            void load(lastEndfDir);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialDir]);

    const browseDirectory = async (): Promise<void> => {
        const props: OpenFileDialogProps = {
            title: 'Select ENDF Library Directory',
            canSelectFiles: false,
            canSelectFolders: true
        };
        const uri = await fileDialogService.showOpenDialog(props);
        if (uri) {
            const dir = uri.path.toString();
            setDirectory(dir);
            lastEndfDir = dir;
            onDirChange?.(dir);
            await load(dir);
        }
    };

    const selectNuclide = async (entry: EndfNuclideEntry): Promise<void> => {
        setSelected(entry);
        setDetail(undefined);
        setDetailLoading(true);
        setEnergyIndex(0);
        try {
            setDetail(await backendService.getEndfDetail({ file: entry.file }));
        } catch (error) {
            setDetail({ success: false, error: String(error) });
        } finally {
            setDetailLoading(false);
        }
    };

    const filtered = (sublib?.nuclides ?? []).filter((n) => n.name.toLowerCase().includes(filter.toLowerCase()));

    return (
        <div className="ncrystal-tab">
            <div className="nuclide-list-panel">
                <div className="nuclide-toolbar">
                    <input type="text" placeholder="Search nuclides…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </div>
                <div className="ncrystal-toolbar-actions">
                    <Tooltip content="Choose the ENDF library root (contains decay/, nfy/, neutrons/, …)" position="bottom">
                        <button className="theia-button secondary" onClick={() => browseDirectory()}>
                            <i className="codicon codicon-folder-opened"></i> Library…
                        </button>
                    </Tooltip>
                    <Tooltip content="Reload the library" position="bottom">
                        <button className="theia-button secondary" disabled={listLoading || !directory} onClick={() => load(directory)}>
                            <i className="codicon codicon-refresh"></i>
                        </button>
                    </Tooltip>
                </div>
                {evaluations?.success && evaluations.sublibraries && (
                    <div className="endf-sublib-row">
                        {evaluations.sublibraries.map((s) => (
                            <button
                                key={s.name}
                                className={`theia-button${sublib?.name === s.name ? '' : ' secondary'}`}
                                onClick={() => {
                                    setSublib(s);
                                    setSelected(undefined);
                                    setDetail(undefined);
                                }}
                            >
                                {s.name} ({s.nuclideCount})
                            </button>
                        ))}
                    </div>
                )}
                {listLoading && (
                    <div className="empty-state">
                        <i className="codicon codicon-loading codicon-modifier-spin"></i>
                        <p>Scanning library…</p>
                    </div>
                )}
                {!listLoading && evaluations && !evaluations.success && (
                    <div className="empty-state">
                        <i className="codicon codicon-error"></i>
                        <p>{evaluations.error}</p>
                    </div>
                )}
                {!listLoading && !evaluations && (
                    <div className="empty-state">
                        <i className="codicon codicon-info"></i>
                        <p>No ENDF library loaded</p>
                        <p className="empty-hint">Choose a library root containing decay/, nfy/, neutrons/, … sub-directories.</p>
                    </div>
                )}
                {!listLoading && sublib && (
                    <div className="nuclide-table-wrapper">
                        <table className="nuclide-table">
                            <thead>
                                <tr>
                                    <th>Nuclide</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.map((n) => (
                                    <tr
                                        key={n.file}
                                        className={selected?.file === n.file ? 'selected' : ''}
                                        onClick={() => selectNuclide(n)}
                                    >
                                        <td>{n.name}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
                {sublib && <div className="nuclide-list-footer">{sublib.name}</div>}
            </div>

            <div className="nuclide-detail-panel">
                {detailLoading && <p className="form-hint">Loading {selected?.name}…</p>}
                {!detailLoading && !detail && (
                    <div className="empty-state">
                        <i className="codicon codicon-info"></i>
                        <p>Select a nuclide to inspect its evaluation</p>
                    </div>
                )}
                {!detailLoading && detail && !detail.success && (
                    <div className="empty-state">
                        <i className="codicon codicon-error"></i>
                        <p>{detail.error}</p>
                    </div>
                )}
                {!detailLoading && detail?.success && selected && renderDetail(detail, selected, energyIndex, setEnergyIndex)}
            </div>
        </div>
    );
};

function renderDetail(
    detail: EndfDetailResult,
    entry: EndfNuclideEntry,
    energyIndex: number,
    setEnergyIndex: (i: number) => void
): React.ReactNode {
    if (detail.kind === 'decay') {
        return (
            <div className="ncrystal-info">
                <div className="detail-header">
                    <h4>
                        <i className="codicon codicon-symbol-atom"></i> {detail.nuclide}
                    </h4>
                    {detail.stable ? (
                        <span className="fission-chip">stable</span>
                    ) : (
                        detail.halfLife && <span className="fission-chip">t½ = {formatHalfLife(detail.halfLife.seconds)}</span>
                    )}
                </div>
                {detail.halfLife && (
                    <div className="detail-row">
                        <span className="detail-label">Half-life:</span>
                        <span>
                            {formatHalfLife(detail.halfLife.seconds)} ({detail.halfLife.seconds.toExponential(4)} s
                            {detail.halfLife.secondsStdDev ? ` ± ${detail.halfLife.secondsStdDev.toExponential(1)}` : ''})
                        </span>
                    </div>
                )}
                <div className="detail-row">
                    <span className="detail-label">Decay modes ({detail.modes?.length ?? 0}):</span>
                </div>
                <table className="nuclide-table endf-detail-table">
                    <thead>
                        <tr>
                            <th>Mode</th>
                            <th>Daughter</th>
                            <th className="numeric">Branching</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(detail.modes ?? []).map((m, i) => (
                            <tr key={i}>
                                <td>{m.modes.join(' + ')}</td>
                                <td>{m.daughter}</td>
                                <td className="numeric">
                                    {formatYield(m.branchingRatio)}
                                    {m.branchingStdDev ? ` ± ${formatYield(m.branchingStdDev)}` : ''}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        );
    }

    if (detail.kind === 'nfy' || detail.kind === 'sfy') {
        const energies = detail.energies ?? [];
        const entry0 = energies[Math.min(energyIndex, Math.max(0, energies.length - 1))];
        return (
            <div className="ncrystal-info">
                <div className="detail-header">
                    <h4>
                        <i className="codicon codicon-symbol-atom"></i> {detail.nuclide} —{' '}
                        {detail.kind === 'nfy' ? 'neutron-induced' : 'spontaneous'} fission yields
                    </h4>
                </div>
                <div className="endf-sublib-row">
                    {energies.map((e, i) => (
                        <button
                            key={e.energy}
                            className={`theia-button${i === energyIndex ? '' : ' secondary'}`}
                            onClick={() => setEnergyIndex(i)}
                        >
                            {formatEnergyEeV(e.energy)}
                        </button>
                    ))}
                </div>
                {entry0 && (
                    <>
                        <div className="detail-row">
                            <span className="detail-label">Products:</span>
                            <span>
                                {entry0.productCount} (total yield {entry0.totalYield.toFixed(3)}) — top {entry0.topProducts.length} shown
                            </span>
                        </div>
                        <table className="nuclide-table endf-detail-table">
                            <thead>
                                <tr>
                                    <th>Nuclide</th>
                                    <th className="numeric">Yield</th>
                                </tr>
                            </thead>
                            <tbody>
                                {entry0.topProducts.map((p) => (
                                    <tr key={p.nuclide}>
                                        <td>{p.nuclide}</td>
                                        <td className="numeric">{formatYield(p.yield)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
            </div>
        );
    }

    // neutron (and other) evaluations: reaction section chips
    const reactions = detail.reactions ?? [];
    return (
        <div className="ncrystal-info">
            <div className="detail-header">
                <h4>
                    <i className="codicon codicon-symbol-atom"></i> {entry.name}
                </h4>
                {detail.za !== null && detail.za !== undefined && <span className="fission-chip">ZA {detail.za}</span>}
                <span className="fission-chip">{detail.sectionCount} sections</span>
            </div>
            <div className="detail-row">
                <span className="detail-label">Reactions ({reactions.filter((r) => r.mf === 3).length} in MF3):</span>
            </div>
            <div className="reaction-grid">
                {reactions.map((r) => (
                    <Tooltip key={`${r.mf}-${r.mt}`} content={`MF ${r.mf}, MT ${r.mt}`} position="top">
                        <span className="reaction-chip">{r.label}</span>
                    </Tooltip>
                ))}
            </div>
        </div>
    );
}
