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
import { ColorPicker, NukeSelect, NukeSlider, Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import type { BivariateOptions, UncertaintyChannel } from '../viewer-core/bivariate-mapping';
import {
    DEFAULT_BIVARIATE_OPTIONS,
    bivariateRgba,
    isUncertaintyChannel,
    normalizeMaxRelativeError
} from '../viewer-core/bivariate-mapping';
import './uncertainty-editor.css';

/** Slider bounds: a threshold below 0.5% is unreadable at 1% steps, above 100% never masks. */
export const MIN_MAX_RELATIVE_ERROR = 0.005;
export const MAX_MAX_RELATIVE_ERROR = 1;

/** Illustrative mean color for the legend swatches (colormap samples are not required). */
const LEGEND_MEAN_COLOR = [0.24, 0.55, 0.85] as const;

const CHANNEL_LABELS: Record<UncertaintyChannel, string> = {
    opacity: 'Opacity',
    desaturate: 'Desaturate',
    noise: 'Noise'
};

const CHANNEL_TOOLTIPS: Record<UncertaintyChannel, string> = {
    opacity:
        'Opacity: cells become progressively transparent as the relative error grows. Cells at or above the threshold are fully masked and invisible.',
    desaturate:
        'Desaturate: cells stay opaque and fade toward the mask color as the relative error grows, so poor statistics read as flat gray instead of bright color.',
    noise: 'Noise: cells stay opaque and fade toward the mask color; the renderer also dithers unreliable cells with a noise texture so low statistics read as grainy rather than smoothly shaded.'
};

const CHANNEL_HINTS: Record<UncertaintyChannel, string> = {
    opacity: 'Unreliable cells fade out.',
    desaturate: 'Unreliable cells fade toward the mask color.',
    noise: 'Unreliable cells fade toward the mask color and dither.'
};

const CHANNEL_OPTIONS = (Object.keys(CHANNEL_LABELS) as UncertaintyChannel[]).map((value) => ({
    value,
    label: CHANNEL_LABELS[value]
}));

/** Evenly spaced quality weights for the legend strip (1 = reliable, 0 = masked). */
const LEGEND_WEIGHTS = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];

function cssRgba([r, g, b, a]: [number, number, number, number]): string {
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

/**
 * Bivariate uncertainty editor for Viewer Settings.
 *
 * Props-only: the host owns persistence and passes the current
 * {@link BivariateOptions} fields; every control emits the complete next
 * options object through `onChange` (never a patch), so the host can store it
 * as one settings value. No Theia DI, no services, no global state.
 *
 * Channel meaning (also in the tooltips): `opacity` fades unreliable cells
 * out, `desaturate` keeps them opaque and fades them toward the mask color,
 * `noise` additionally asks the renderer for a dither texture. The strip
 * under the controls previews the current encoding against an example mean
 * color; the labels show the relative error each swatch represents.
 */
export interface UncertaintyEditorProps {
    readonly channel: UncertaintyChannel;
    readonly maxRelativeError: number;
    readonly lowQualityColor: string;
    /** Receives the complete next options object. */
    readonly onChange: (options: BivariateOptions) => void;
    /** Extra class on the editor root (layout passthrough only). */
    readonly className?: string;
}

export const UncertaintyEditor: React.FC<UncertaintyEditorProps> = ({
    channel,
    maxRelativeError,
    lowQualityColor,
    onChange,
    className
}) => {
    const normalizedChannel = isUncertaintyChannel(channel) ? channel : DEFAULT_BIVARIATE_OPTIONS.channel;
    // The editor owns the usable range: a stale preference outside it is
    // shown (and re-emitted) clamped, so the slider, percent label and legend
    // always describe the same threshold.
    const threshold = Math.min(MAX_MAX_RELATIVE_ERROR, Math.max(MIN_MAX_RELATIVE_ERROR, normalizeMaxRelativeError(maxRelativeError)));
    const options: BivariateOptions = {
        channel: normalizedChannel,
        maxRelativeError: threshold,
        lowQualityColor
    };
    const update = (patch: Partial<BivariateOptions>): void => onChange({ ...options, ...patch });
    const rootClass = className ? `uncertainty-editor ${className}` : 'uncertainty-editor';

    return (
        <div className={rootClass}>
            <div className="uncertainty-editor-row">
                <Tooltip content={CHANNEL_TOOLTIPS[normalizedChannel]} position="top">
                    <span className="uncertainty-editor-label">Channel</span>
                </Tooltip>
                <NukeSelect
                    className="uncertainty-editor-channel"
                    ariaLabel="Uncertainty channel"
                    value={normalizedChannel}
                    options={CHANNEL_OPTIONS}
                    onChange={(value) => {
                        if (isUncertaintyChannel(value)) {
                            update({ channel: value });
                        }
                    }}
                />
            </div>
            <div className="uncertainty-editor-hint">{CHANNEL_HINTS[normalizedChannel]}</div>

            <div className="uncertainty-editor-row">
                <Tooltip
                    content="Relative statistical error above which a cell counts as unreliable and takes the mask color. Lower values show more of the uncertainty."
                    position="top"
                >
                    <span className="uncertainty-editor-label">Max rel. error</span>
                </Tooltip>
                <div className="uncertainty-editor-slider">
                    <NukeSlider
                        ariaLabel="Maximum relative error"
                        min={MIN_MAX_RELATIVE_ERROR}
                        max={MAX_MAX_RELATIVE_ERROR}
                        step={0.005}
                        value={threshold}
                        onChange={(value) => update({ maxRelativeError: value })}
                    />
                </div>
                <span className="uncertainty-editor-value">{formatPercent(threshold)}</span>
            </div>

            <div className="uncertainty-editor-row">
                <Tooltip content="Color painted on cells whose relative error is at or above the threshold." position="top">
                    <span className="uncertainty-editor-label">Mask color</span>
                </Tooltip>
                <ColorPicker value={lowQualityColor} onChange={(color) => update({ lowQualityColor: color })} />
            </div>

            <div className="uncertainty-editor-legend" role="img" aria-label="Uncertainty color scale">
                {LEGEND_WEIGHTS.map((weight) => {
                    const rgba = bivariateRgba(LEGEND_MEAN_COLOR, weight, options);
                    return (
                        <span
                            key={weight}
                            className="uncertainty-editor-legend-swatch"
                            style={{ backgroundColor: cssRgba(rgba) }}
                            title={`${formatPercent((1 - weight) * options.maxRelativeError)} relative error`}
                        />
                    );
                })}
            </div>
            <div className="uncertainty-editor-legend-scale">
                <span>Reliable</span>
                <span>≥ {formatPercent(options.maxRelativeError)}</span>
            </div>
        </div>
    );
};
