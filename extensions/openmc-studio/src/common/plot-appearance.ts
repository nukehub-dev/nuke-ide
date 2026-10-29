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
 * Shared rules for the native plotting appearance controls.
 *
 * OpenMC applies background colors and cell/material masks to slice and
 * ray-traced plots; voxel files store raw IDs and ignore display colors.
 * Overlap detection is a slice-only feature (openmc/plots.py, src/plot.cpp).
 */

import { OpenMCPlotConfig, OpenMCState } from './openmc-state-schema';

/** RGB color triple in the 0-255 range. */
export type PlotRGB = [number, number, number];

/** Appearance field that produced a validation issue. */
export type PlotAppearanceField = 'background' | 'mask' | 'overlaps';

/** Non-blocking appearance issue for one plot. */
export interface PlotAppearanceIssue {
    /** Plot that owns the issue. */
    plotId: number;
    /** Field the issue belongs to. */
    field: PlotAppearanceField;
    /** Human-readable explanation of the problem. */
    message: string;
    /** How the user can resolve the issue. */
    suggestion: string;
}

/** One selectable cell or material domain. */
export interface PlotDomainOption {
    /** Cell or material ID. */
    id: number;
    /** Display name, falling back to the ID. */
    label: string;
}

/** Default plot background in OpenMC (black). */
export const DEFAULT_PLOT_BACKGROUND: PlotRGB = [0, 0, 0];

/** Default mask background in OpenMC (white). */
export const DEFAULT_MASK_BACKGROUND: PlotRGB = [255, 255, 255];

/** Default overlap highlight color in OpenMC (red). */
export const DEFAULT_OVERLAP_COLOR: PlotRGB = [255, 0, 0];

/** Human-readable plot type name. */
export function plotTypeLabel(type: OpenMCPlotConfig['type']): string {
    switch (type) {
        case 'slice':
            return 'slice';
        case 'voxel':
            return 'voxel';
        case 'solid-raytrace':
            return 'solid ray-trace';
        case 'wireframe-raytrace':
            return 'wireframe ray-trace';
    }
}

/**
 * Whether OpenMC renders a background color for this plot type.
 * Voxel output stores IDs rather than colors, so display colors do not apply.
 */
export function plotSupportsBackground(type: OpenMCPlotConfig['type']): boolean {
    return type !== 'voxel';
}

/**
 * Whether OpenMC applies cell/material masks to this plot type.
 * Voxel output stores IDs rather than colors, so masks do not apply.
 */
export function plotSupportsMask(type: OpenMCPlotConfig['type']): boolean {
    return type !== 'voxel';
}

/** Whether OpenMC detects and colors overlapping cells for this plot type. */
export function plotSupportsOverlaps(type: OpenMCPlotConfig['type']): boolean {
    return type === 'slice';
}

/**
 * List the cell or material domains a mask can reference for this plot.
 * `colorBy` decides which ID space the components use; non-material values
 * fall back to cells, matching the exporter's coercion.
 */
export function getPlotDomainOptions(state: OpenMCState, colorBy: OpenMCPlotConfig['colorBy']): PlotDomainOption[] {
    if (colorBy === 'material') {
        return state.materials.map((material) => ({
            id: material.id,
            label: material.name || `Material ${material.id}`
        }));
    }
    return state.geometry.cells.map((cell) => ({
        id: cell.id,
        label: cell.name || `Cell ${cell.id}`
    }));
}

/**
 * Convert the IDE's visible-domain selection into OpenMC's mask components.
 *
 * The OpenMC renderer paints the listed `mask` components with the mask
 * background; the complement stays visible. The IDE stores the domains the
 * user chose to show, so plots.xml and Python must carry the complement.
 */
export function toOpenMcMaskComponents(plot: OpenMCPlotConfig, state: OpenMCState): number[] {
    const selected = new Set(plot.mask?.components ?? []);
    return getPlotDomainOptions(state, plot.colorBy)
        .map((domain) => domain.id)
        .filter((id) => !selected.has(id));
}

/** Visible-domain selection reconstructed from an OpenMC mask. */
export interface OpenMcMaskSelection {
    /** Existing domains left visible by the mask. */
    visible: number[];
    /** Mask components that do not exist in the current geometry. */
    missing: number[];
}

/** Invert an OpenMC `mask` component list into the IDE's visible selection. */
export function fromOpenMcMaskComponents(
    components: number[],
    state: OpenMCState,
    colorBy: OpenMCPlotConfig['colorBy']
): OpenMcMaskSelection {
    const domainIds = getPlotDomainOptions(state, colorBy).map((domain) => domain.id);
    const available = new Set(domainIds);
    const hidden = new Set(components);
    return {
        visible: domainIds.filter((id) => !hidden.has(id)),
        missing: components.filter((id, index) => !available.has(id) && components.indexOf(id) === index)
    };
}

/** Mask components that no longer exist in the current geometry. */
export function getMissingMaskComponents(plot: OpenMCPlotConfig, state: OpenMCState): number[] {
    const components = plot.mask?.components ?? [];
    if (components.length === 0) {
        return [];
    }
    const available = new Set(getPlotDomainOptions(state, plot.colorBy).map((domain) => domain.id));
    return components.filter((id, index) => !available.has(id) && components.indexOf(id) === index);
}

/** Counts used by the mask editor summary. */
export interface PlotMaskSummary {
    /** Domains in the current geometry that the mask can reference. */
    total: number;
    /** Existing domains selected as visible. */
    visible: number;
    /** Selected IDs that no longer exist in the geometry. */
    missing: number;
}

/** Summarize a mask selection against the current geometry. */
export function getPlotMaskSummary(plot: OpenMCPlotConfig, state: OpenMCState): PlotMaskSummary {
    const domains = getPlotDomainOptions(state, plot.colorBy);
    const selected = new Set(plot.mask?.components ?? []);
    const visible = domains.filter((domain) => selected.has(domain.id)).length;
    const missing = getMissingMaskComponents(plot, state).length;
    return { total: domains.length, visible, missing };
}

/**
 * Python assignment lines for the plot's background, mask, and overlap fields.
 * Only fields OpenMC actually applies to the plot type are emitted.
 */
export function generatePlotAppearancePythonLines(plot: OpenMCPlotConfig, state: OpenMCState): string[] {
    const lines: string[] = [];
    const target = `plot_${plot.id}`;
    if (plotSupportsBackground(plot.type) && plot.background) {
        lines.push(`${target}.background = (${plot.background.join(', ')})`);
    }
    const maskComponents = plot.mask && plot.mask.components.length > 0 ? toOpenMcMaskComponents(plot, state) : [];
    const visibleMaskDomains = plot.mask ? getPlotMaskSummary(plot, state).visible : 0;
    if (plotSupportsMask(plot.type) && visibleMaskDomains > 0 && maskComponents.length > 0) {
        lines.push(`${target}.mask_components = [${maskComponents.join(', ')}]`);
        if (plot.mask?.background) {
            lines.push(`${target}.mask_background = (${plot.mask.background.join(', ')})`);
        }
    }
    if (plotSupportsOverlaps(plot.type) && plot.showOverlaps) {
        lines.push(`${target}.show_overlaps = True`);
        if (plot.overlapColor) {
            lines.push(`${target}.overlap_color = (${plot.overlapColor.join(', ')})`);
        }
    }
    return lines;
}

/** Whether a value is a valid 0-255 RGB triple. */
export function isValidPlotRgb(value: unknown): value is PlotRGB {
    return (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every((component) => Number.isInteger(component) && component >= 0 && component <= 255)
    );
}

/** Convert an RGB triple to the hex string used by the shared ColorPicker. */
export function plotRgbToHex(color: PlotRGB): string {
    return `#${color
        .map((component) =>
            Math.max(0, Math.min(255, Math.round(component)))
                .toString(16)
                .padStart(2, '0')
        )
        .join('')}`.toUpperCase();
}

/** Parse a ColorPicker hex value into an RGB triple. */
export function plotHexToRgb(hex: string): PlotRGB | undefined {
    const normalized = hex.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(normalized)) {
        return [
            parseInt(normalized[0] + normalized[0], 16),
            parseInt(normalized[1] + normalized[1], 16),
            parseInt(normalized[2] + normalized[2], 16)
        ];
    }
    if (!/^[0-9a-f]{6}$/i.test(normalized)) {
        return undefined;
    }
    return [parseInt(normalized.slice(0, 2), 16), parseInt(normalized.slice(2, 4), 16), parseInt(normalized.slice(4, 6), 16)];
}

/**
 * Validate the appearance fields a plot carries.
 *
 * These are warnings, not errors: OpenMC still renders the plot, but the
 * selected appearance will not have the effect the state implies.
 */
export function validatePlotAppearance(plot: OpenMCPlotConfig, state: OpenMCState): PlotAppearanceIssue[] {
    const issues: PlotAppearanceIssue[] = [];
    const label = `Plot #${plot.id}${plot.name ? ` "${plot.name}"` : ''}`;
    const hasBackground = plot.background !== undefined;
    const hasMask = plot.mask !== undefined;
    const hasOverlaps = plot.showOverlaps === true;
    const hasOverlapColor = plot.overlapColor !== undefined;

    if (!plotSupportsBackground(plot.type) && (hasBackground || hasMask || hasOverlaps || hasOverlapColor)) {
        issues.push({
            plotId: plot.id,
            field: hasMask ? 'mask' : hasOverlaps || hasOverlapColor ? 'overlaps' : 'background',
            message: `${label} is a ${plotTypeLabel(plot.type)} plot; OpenMC stores raw cell/material IDs there and does not apply background, mask, or overlap colors.`,
            suggestion: 'Use a slice or ray-traced plot for appearance controls, or remove these fields from the voxel plot.'
        });
        return issues;
    }

    if (!plotSupportsMask(plot.type) && hasMask) {
        issues.push({
            plotId: plot.id,
            field: 'mask',
            message: `${label} is a ${plotTypeLabel(plot.type)} plot, which does not render cell/material masks.`,
            suggestion: 'Use a slice or ray-traced plot for masking.'
        });
    } else if (hasMask) {
        const components = plot.mask?.components ?? [];
        if (components.length === 0) {
            issues.push({
                plotId: plot.id,
                field: 'mask',
                message: `${label} has masking enabled but no ${plot.colorBy === 'material' ? 'materials' : 'cells'} selected.`,
                suggestion: 'Pick at least one domain; no mask is written until the selection is non-empty.'
            });
        }
        const missing = getMissingMaskComponents(plot, state);
        if (missing.length > 0) {
            issues.push({
                plotId: plot.id,
                field: 'mask',
                message: `${label} masks ${plot.colorBy === 'material' ? 'material' : 'cell'} IDs that are not in the current geometry: ${missing.join(', ')}.`,
                suggestion: 'Remove the missing IDs from the mask or add the domains to the model.'
            });
        }
        const summary = getPlotMaskSummary(plot, state);
        if (components.length > 0 && summary.visible === 0) {
            issues.push({
                plotId: plot.id,
                field: 'mask',
                message: `${label} has no existing domains selected, so no mask is written.`,
                suggestion: 'Select at least one domain that is present in the current model.'
            });
        } else if (components.length > 0 && summary.total > 0 && summary.visible === summary.total) {
            issues.push({
                plotId: plot.id,
                field: 'mask',
                message: `${label} selects every domain, so the mask has no visible effect.`,
                suggestion: 'Deselect at least one domain or remove the mask.'
            });
        }
        if (plot.mask?.background !== undefined && !isValidPlotRgb(plot.mask.background)) {
            issues.push({
                plotId: plot.id,
                field: 'mask',
                message: `${label} has an invalid mask background color.`,
                suggestion: 'Set each RGB component to an integer between 0 and 255.'
            });
        }
    }

    if (hasOverlaps && !plotSupportsOverlaps(plot.type)) {
        issues.push({
            plotId: plot.id,
            field: 'overlaps',
            message: `${label} requests overlap highlighting on a ${plotTypeLabel(plot.type)} plot; OpenMC only detects overlaps for slice plots.`,
            suggestion: 'Use a slice plot for overlap highlighting.'
        });
    }
    if (hasOverlapColor && !hasOverlaps) {
        issues.push({
            plotId: plot.id,
            field: 'overlaps',
            message: `${label} sets an overlap color without enabling overlap highlighting; OpenMC rejects that combination.`,
            suggestion: 'Enable Highlight overlaps or clear the overlap color.'
        });
    }
    if (hasOverlapColor && !isValidPlotRgb(plot.overlapColor)) {
        issues.push({
            plotId: plot.id,
            field: 'overlaps',
            message: `${label} has an invalid overlap color.`,
            suggestion: 'Set each RGB component to an integer between 0 and 255.'
        });
    }
    if (hasBackground && !isValidPlotRgb(plot.background)) {
        issues.push({
            plotId: plot.id,
            field: 'background',
            message: `${label} has an invalid background color.`,
            suggestion: 'Set each RGB component to an integer between 0 and 255.'
        });
    }

    return issues;
}
