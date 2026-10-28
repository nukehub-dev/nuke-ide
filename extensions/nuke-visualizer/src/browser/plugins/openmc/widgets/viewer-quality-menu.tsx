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
import { NukeSelect, Tooltip, type NukeSelectOption } from 'nuke-essentials/lib/theme/browser/components';
import './viewer-quality-menu.css';

/** Metrics accepted by `base.mesh-quality` that make sense in the viewer. */
export type MeshQualityMetric = 'aspect' | 'area' | 'min-angle' | 'volume';

export const MESH_QUALITY_METRICS: readonly MeshQualityMetric[] = ['aspect', 'area', 'min-angle', 'volume'];

const METRIC_LABELS: Readonly<Record<MeshQualityMetric, string>> = {
    aspect: 'Aspect ratio',
    area: 'Area',
    'min-angle': 'Min angle',
    volume: 'Volume'
};

const METRIC_OPTIONS: readonly NukeSelectOption[] = MESH_QUALITY_METRICS.map((metric) => ({
    value: metric,
    label: METRIC_LABELS[metric]
}));

export interface ViewerQualityMenuProps {
    readonly disabled?: boolean;
    /** Run `base.mesh-quality` and open the resulting dataset. */
    readonly onApply: (metric: MeshQualityMetric) => void;
}

/**
 * Props-only mesh-quality popover for the native viewer. The host owns the
 * backend command and the new-tab handoff; this component only picks a
 * metric and closes.
 */
export const ViewerQualityMenu: React.FC<ViewerQualityMenuProps> = ({ disabled = false, onApply }) => {
    const [open, setOpen] = React.useState(false);
    const [metric, setMetric] = React.useState<MeshQualityMetric>('aspect');
    const rootRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (disabled) {
            setOpen(false);
        }
    }, [disabled]);

    React.useEffect(() => {
        if (!open) {
            return;
        }
        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target;
            if (target instanceof Node && rootRef.current?.contains(target)) {
                return;
            }
            if (target instanceof Element && target.closest('.nuke-select-list')) {
                return;
            }
            setOpen(false);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [open]);

    return (
        <div ref={rootRef} className="viewer-quality-menu">
            <Tooltip content="Mesh quality — write a metric array and open it in a new viewer" position="left">
                <button
                    className={`theia-button secondary nuke-viewer-nav-bar-button viewer-quality-trigger${open ? ' active' : ''}`}
                    disabled={disabled}
                    onClick={() => setOpen((current) => !current)}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label="Mesh quality options"
                >
                    <span className="codicon codicon-checklist" />
                </button>
            </Tooltip>
            {open && (
                <div className="viewer-quality-popover" role="dialog" aria-label="Mesh quality options">
                    <div className="viewer-quality-title">Mesh quality</div>
                    <div className="viewer-quality-row">
                        <span>Metric</span>
                        <NukeSelect
                            className="viewer-quality-select"
                            ariaLabel="Mesh quality metric"
                            value={metric}
                            options={METRIC_OPTIONS}
                            disabled={disabled}
                            onChange={(value) => setMetric(MESH_QUALITY_METRICS.find((entry) => entry === value) ?? 'aspect')}
                        />
                    </div>
                    <button
                        className="theia-button viewer-quality-apply"
                        disabled={disabled}
                        onClick={() => {
                            onApply(metric);
                            setOpen(false);
                        }}
                    >
                        Write metric &amp; open
                    </button>
                </div>
            )}
        </div>
    );
};
