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

/**
 * Experimental W7-X coil-count study UI.
 *
 * The dialog selects 4/5/6 modules and renders the measured report for that
 * count; it never edits the document. The banner is the persistent,
 * non-dismissible reminder that a document is a design study and that
 * simulation export is disabled.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { NukeDialog } from 'nuke-essentials/lib/theme/browser/components';
import type { W7xDesignStudy } from '../../../common/cad-document';
import { W7X_STUDY_MODULE_COUNTS, type W7xStudyModuleCount } from '../../../common/w7x-study';
import {
    W7X_STUDY_DEFAULT_MODULE_COUNT,
    W7X_STUDY_EXPORT_NOTE,
    W7X_STUDY_WARNING,
    buildW7xDesignStudyBanner,
    buildW7xStudyReportView,
    selectW7xStudyReport,
    type W7xStudyReportSet
} from './w7x-study-model';

export interface W7xStudyDialogProps {
    /** Copied source file name shown under the title. */
    readonly sourceLabel: string;
    /** Committed measured reports for 4/5/6 modules. */
    readonly reports: W7xStudyReportSet;
    /** Initial selection; defaults to the physically valid five-module layout. */
    readonly initialModuleCount?: W7xStudyModuleCount;
    /** True while the widget creates the document; disables every action. */
    readonly busy?: boolean;
    readonly onConfirm: (moduleCount: W7xStudyModuleCount) => void;
    readonly onCancel: () => void;
}

function moduleLabel(moduleCount: W7xStudyModuleCount): string {
    return `${moduleCount} modules`;
}

function instanceSummary(moduleCount: W7xStudyModuleCount): string {
    const coils = moduleCount * 10;
    return `${coils} coil + 5 shell instances (${coils + 5} total)`;
}

/** Dialog body + footer; local state is only the module-count selection. */
export function W7xStudyDialog(props: W7xStudyDialogProps): React.ReactElement {
    const [moduleCount, setModuleCount] = React.useState<W7xStudyModuleCount>(props.initialModuleCount ?? W7X_STUDY_DEFAULT_MODULE_COUNT);
    const busy = props.busy === true;
    const report = selectW7xStudyReport(props.reports, moduleCount);
    const view = buildW7xStudyReportView(report);

    return (
        <NukeDialog
            title={
                <div className="cad-w7x-study-title">
                    <span>Create W7-X Coil Study</span>
                    <span className="cad-w7x-study-subtitle">{props.sourceLabel}</span>
                </div>
            }
            onClose={busy ? undefined : props.onCancel}
            className="cad-w7x-study-dialog"
            maxWidth={780}
            footer={
                <>
                    <span className="cad-w7x-study-footer-note" role="status" aria-live="polite">
                        Creates 15 imported bodies and {instanceSummary(moduleCount)}.
                    </span>
                    <button className="theia-button secondary" onClick={props.onCancel} disabled={busy}>
                        Cancel
                    </button>
                    <button className="theia-button" onClick={() => props.onConfirm(moduleCount)} disabled={busy}>
                        {busy ? 'Creating study…' : `Create ${moduleCount}-Module Study`}
                    </button>
                </>
            }
        >
            <div className="cad-w7x-study-warning" role="alert">
                <span className="codicon codicon-warning" />
                <div>
                    <strong>{W7X_STUDY_WARNING}</strong>
                    <div>
                        This document is built for visual comparison only. {W7X_STUDY_EXPORT_NOTE}; use the valid 5-module W7-X generator
                        for simulation-ready geometry.
                    </div>
                </div>
            </div>

            <div className="cad-w7x-study-module-row" role="group" aria-label="Study module count">
                <span className="cad-w7x-study-module-label">Module count</span>
                {W7X_STUDY_MODULE_COUNTS.map((count) => (
                    <button
                        key={count}
                        className={`theia-button secondary cad-w7x-study-module${count === moduleCount ? ' active' : ''}`}
                        aria-pressed={count === moduleCount}
                        onClick={() => setModuleCount(count)}
                        disabled={busy}
                    >
                        {moduleLabel(count)}
                    </button>
                ))}
            </div>

            <div className={`cad-w7x-study-report ${view.valid ? 'valid' : 'invalid'}`}>
                <div className="cad-w7x-study-report-header">
                    <span className="cad-w7x-study-report-title">Measured report</span>
                    <span className={`cad-w7x-study-status ${view.valid ? 'valid' : 'invalid'}`}>{view.statusLabel}</span>
                </div>
                <div className="cad-w7x-study-summary">{view.summary}</div>
                <table className="cad-w7x-study-metrics" aria-label={`${moduleCount}-module measured report`}>
                    <tbody>
                        {view.metrics.map((metric) => (
                            <tr key={metric.id}>
                                <th scope="row">{metric.label}</th>
                                <td>{metric.value}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="cad-w7x-study-collisions">
                <div className="cad-w7x-study-collision-section">
                    <div className="cad-w7x-study-collision-title">
                        Coil–coil collisions <span className="cad-w7x-study-count">{view.coilCoilOverlaps.length}</span>
                    </div>
                    {view.coilCoilOverlaps.length === 0 ? (
                        <div className="cad-w7x-study-empty">No measured coil–coil intersections.</div>
                    ) : (
                        <table className="cad-w7x-study-overlap-table" aria-label="Coil–coil collisions">
                            <thead>
                                <tr>
                                    <th scope="col">Instance A</th>
                                    <th scope="col">Instance B</th>
                                    <th scope="col">Intersection volume</th>
                                </tr>
                            </thead>
                            <tbody>
                                {view.coilCoilOverlaps.map((overlap) => (
                                    <tr key={`${overlap.a}:${overlap.b}`}>
                                        <td>{overlap.a}</td>
                                        <td>{overlap.b}</td>
                                        <td>{overlap.volume}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                <div className="cad-w7x-study-collision-section">
                    <div className="cad-w7x-study-collision-title">
                        Coil–shell collisions <span className="cad-w7x-study-count">{view.coilShellOverlaps.length}</span>
                    </div>
                    {view.coilShellOverlaps.length === 0 ? (
                        <div className="cad-w7x-study-empty">No measured coil–shell intersections.</div>
                    ) : (
                        <table className="cad-w7x-study-overlap-table" aria-label="Coil–shell collisions">
                            <thead>
                                <tr>
                                    <th scope="col">Coil instance</th>
                                    <th scope="col">Shell</th>
                                    <th scope="col">Intersection volume</th>
                                </tr>
                            </thead>
                            <tbody>
                                {view.coilShellOverlaps.map((overlap) => (
                                    <tr key={`${overlap.a}:${overlap.b}`}>
                                        <td>{overlap.a}</td>
                                        <td>{overlap.b}</td>
                                        <td>{overlap.volume}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </div>
        </NukeDialog>
    );
}

export interface W7xDesignStudyBannerProps {
    /** Design-study marker stored on the document (count or shape study). */
    readonly study: W7xDesignStudy;
}

/**
 * Persistent viewport banner for a design-study document.
 *
 * Deliberately has no close/dismiss control: the document stays marked until
 * the user creates a normal document, so the warning must remain visible.
 */
export function W7xDesignStudyBanner(props: W7xDesignStudyBannerProps): React.ReactElement {
    const model = buildW7xDesignStudyBanner(props.study);
    return (
        <div
            className={`cad-viewport-design-study-banner ${model.valid ? 'valid' : 'invalid'}${model.approximate ? ' approximate' : ''}`}
            role="status"
            aria-label={model.ariaLabel}
            data-study-module-count={model.moduleCount}
            data-study-kind={model.kind}
        >
            <span className="codicon codicon-beaker cad-viewport-design-study-icon" />
            <div className="cad-viewport-design-study-body">
                <div className="cad-viewport-design-study-header">
                    <span className="cad-viewport-design-study-title">{model.title}</span>
                    <span className={`cad-viewport-design-study-status ${model.valid ? 'valid' : 'invalid'}`}>{model.statusLabel}</span>
                </div>
                <div className="cad-viewport-design-study-summary">{model.summary}</div>
                <div className="cad-viewport-design-study-note">
                    <span className="codicon codicon-lock" />
                    <span>
                        {model.warning} {model.exportNote}.
                    </span>
                </div>
            </div>
        </div>
    );
}
