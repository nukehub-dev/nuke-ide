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
import { NukeSelect, NukeSwitch, Tooltip, type NukeSelectOption } from 'nuke-essentials/lib/theme/browser/components';
import {
    SCREENSHOT_FORMATS,
    SCREENSHOT_SCALES,
    screenshotFormatSupportsTransparency,
    type ScreenshotFormat,
    type ScreenshotOptions,
    type ScreenshotScale
} from '../../../viewer-core/canvas-screenshot';
import './viewer-export-menu.css';

/**
 * Props-only screenshot/export popover for the native viewers.
 *
 * The host widget owns capture and delivery: `onExport` receives the chosen
 * `ScreenshotOptions` (call `captureRendererScreenshot`, then
 * `downloadScreenshotDataUrl` with the captured data URL), and `onCopy`
 * receives the same options when the host can put the image on the clipboard.
 * No Theia imports and no viewer state — the component only remembers the menu
 * selections between opens, so dropping it into `ViewerFileActions` (or any
 * viewer header) needs no wiring beyond the two callbacks.
 */

/** One select row value/label pair for the format picker. */
const FORMAT_LABELS: Readonly<Record<ScreenshotFormat, string>> = {
    png: 'PNG',
    jpeg: 'JPEG',
    webp: 'WebP'
};

const FORMAT_OPTIONS: readonly NukeSelectOption[] = SCREENSHOT_FORMATS.map((format) => ({
    value: format,
    label: FORMAT_LABELS[format]
}));

const SCALE_OPTIONS: readonly NukeSelectOption[] = SCREENSHOT_SCALES.map((scale) => ({
    value: String(scale),
    label: scale === 1 ? '1× (native)' : `${scale}×`
}));

function toScreenshotFormat(value: string): ScreenshotFormat {
    return SCREENSHOT_FORMATS.find((format) => format === value) ?? 'png';
}

function toScreenshotScale(value: string): ScreenshotScale {
    return SCREENSHOT_SCALES.find((scale) => String(scale) === value) ?? 1;
}

/**
 * Build the options handed to the host. Transparency is dropped for JPEG so
 * the UI and the capture helper agree even while the switch keeps its last
 * user selection.
 */
export function buildViewerExportOptions(format: ScreenshotFormat, scale: ScreenshotScale, transparent: boolean): ScreenshotOptions {
    return {
        format,
        scale,
        transparent: screenshotFormatSupportsTransparency(format) && transparent
    };
}

export interface ViewerExportMenuProps {
    readonly disabled?: boolean;
    /** Download/export with the selected options. */
    readonly onExport: (options: ScreenshotOptions) => void;
    /** Copy to the clipboard with the selected options; when omitted the Copy action stays disabled. */
    readonly onCopy?: (options: ScreenshotOptions) => void;
    /** Export the dataset itself through `base.export` (CSV or VTK). */
    readonly onExportData?: (format: 'csv' | 'vtk') => void;
}

export const ViewerExportMenu: React.FC<ViewerExportMenuProps> = ({ disabled = false, onExport, onCopy, onExportData }) => {
    const [open, setOpen] = React.useState(false);
    const [format, setFormat] = React.useState<ScreenshotFormat>('png');
    const [scale, setScale] = React.useState<ScreenshotScale>(1);
    const [transparent, setTransparent] = React.useState(false);
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
            // NukeSelect portals its dropdown to document.body; a pick inside
            // the list must not dismiss the popover before the click lands.
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

    const transparentAllowed = screenshotFormatSupportsTransparency(format);
    const options = buildViewerExportOptions(format, scale, transparent);

    const run = (action: ((selected: ScreenshotOptions) => void) | undefined) => {
        if (disabled || !action) {
            return;
        }
        action(options);
        setOpen(false);
    };

    return (
        <div ref={rootRef} className="viewer-export-menu">
            <Tooltip content="Export screenshot — choose format, scale, and transparency" position="left">
                <button
                    className={`theia-button secondary nuke-viewer-nav-bar-button viewer-export-trigger${open ? ' active' : ''}`}
                    disabled={disabled}
                    onClick={() => setOpen((current) => !current)}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label="Export screenshot options"
                >
                    <span className="codicon codicon-export" />
                </button>
            </Tooltip>
            {open && (
                <div className="viewer-export-popover" role="dialog" aria-label="Screenshot export options">
                    <div className="viewer-export-title">Screenshot</div>
                    <div className="viewer-export-row">
                        <span className="viewer-export-label">Format</span>
                        <NukeSelect
                            className="viewer-export-select"
                            ariaLabel="Screenshot format"
                            value={format}
                            onChange={(value) => setFormat(toScreenshotFormat(value))}
                            options={FORMAT_OPTIONS}
                            disabled={disabled}
                        />
                    </div>
                    <div className="viewer-export-row">
                        <span className="viewer-export-label">Scale</span>
                        <NukeSelect
                            className="viewer-export-select"
                            ariaLabel="Screenshot resolution scale"
                            value={String(scale)}
                            onChange={(value) => setScale(toScreenshotScale(value))}
                            options={SCALE_OPTIONS}
                            disabled={disabled}
                        />
                    </div>
                    <div className="viewer-export-row">
                        <span className="viewer-export-label">Transparent</span>
                        <NukeSwitch
                            checked={transparentAllowed && transparent}
                            onChange={setTransparent}
                            disabled={disabled || !transparentAllowed}
                            ariaLabel="Transparent screenshot background"
                        />
                    </div>
                    {!transparentAllowed && <div className="viewer-export-hint">Transparency requires PNG or WebP.</div>}
                    <div className="viewer-export-actions">
                        <button
                            className="theia-button secondary viewer-export-action viewer-export-copy"
                            disabled={disabled || !onCopy}
                            onClick={() => run(onCopy)}
                        >
                            Copy
                        </button>
                        <button
                            className="theia-button viewer-export-action viewer-export-export"
                            disabled={disabled}
                            onClick={() => run(onExport)}
                        >
                            Export
                        </button>
                    </div>
                    {onExportData && (
                        <div className="viewer-export-data">
                            <div className="viewer-export-title">Dataset</div>
                            <div className="viewer-export-actions">
                                <button
                                    className="theia-button secondary viewer-export-action viewer-export-data-csv"
                                    disabled={disabled}
                                    onClick={() => {
                                        onExportData('csv');
                                        setOpen(false);
                                    }}
                                >
                                    CSV
                                </button>
                                <button
                                    className="theia-button secondary viewer-export-action viewer-export-data-vtk"
                                    disabled={disabled}
                                    onClick={() => {
                                        onExportData('vtk');
                                        setOpen(false);
                                    }}
                                >
                                    VTK
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};
