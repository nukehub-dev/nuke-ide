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
import { useTooltip } from 'nuke-essentials/lib/theme/browser/components';

import { latticeRingSizes } from '../../../common/geometry-editor';

/**
 * Lattice brush semantics used by both universe editors.
 * `paint` assigns the selected universe to one position, `row`/`ring` fills
 * the position's row/ring, and `clear` writes universe 0.
 */
export type LatticeBrush = 'paint' | 'row' | 'ring' | 'clear';

export interface RectLatticeGridProps {
    /** `[nx, ny, nz]` (nz is 1 for 2D). */
    dimensions: [number, number] | [number, number, number];
    /** Full `[z][y][x]` universe array. */
    universes: number[][][];
    /** Axial slice to display. */
    layer: number;
    /** Display name for a universe id. */
    universeLabel: (id: number) => string;
    /** Click a cell; the caller applies the current brush. */
    onCell: (z: number, y: number, x: number) => void;
    /** Fill one full row (from its header). */
    onFillRow: (z: number, y: number) => void;
}

/**
 * Scrollable rectangular universe grid with column headers and fillable row
 * headers. Cells are real buttons, at least 30 px square, keyboard focusable,
 * and labelled with row/column/universe.
 */
export const RectLatticeGrid: React.FC<RectLatticeGridProps> = ({ dimensions, universes, layer, universeLabel, onCell, onFillRow }) => {
    const [nx, ny] = dimensions;

    return (
        <div className="lattice-grid-scroll">
            <div
                className="lattice-grid-table"
                style={{ gridTemplateColumns: `minmax(34px, auto) repeat(${nx}, minmax(34px, 1fr))` }}
                role="group"
                aria-label="Rectangular lattice universe grid. Row 0 is the top row and x is fastest."
            >
                <span className="lattice-grid-corner" aria-hidden="true">
                    y\x
                </span>
                {Array.from({ length: nx }).map((_, x) => (
                    <span key={`col-${x}`} className="lattice-grid-header">
                        x{x}
                    </span>
                ))}
                {Array.from({ length: ny }).map((__, y) => (
                    <React.Fragment key={`row-${y}`}>
                        <button
                            type="button"
                            className="lattice-grid-header lattice-grid-row-fill"
                            onClick={() => onFillRow(layer, y)}
                            aria-label={`Fill row ${y} with the selected universe`}
                        >
                            y{y}
                        </button>
                        {Array.from({ length: nx }).map((___, x) => (
                            <LatticeCellButton
                                key={`cell-${y}-${x}`}
                                universeId={universes[layer]?.[y]?.[x] ?? 0}
                                universeLabel={universeLabel}
                                ariaLabel={`Row ${y}, column ${x}`}
                                onClick={() => onCell(layer, y, x)}
                            />
                        ))}
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
};

export interface HexLatticeRingsProps {
    /** Ring count including the center ring. */
    rings: number;
    /** One axial slice of the `[z][ring][theta]` universe array. */
    layerUniverses: number[][] | undefined;
    /** Display name for a universe id. */
    universeLabel: (id: number) => string;
    /** Click a ring position; the caller applies the current brush. */
    onCell: (ring: number, theta: number) => void;
    /** Fill one full ring (from its header). */
    onFillRing: (ring: number) => void;
}

/**
 * Scrollable hexagonal ring editor. Ring 0 is the outermost ring; position 0
 * starts at the top and proceeds clockwise, matching `HexLattice.universes`.
 */
export const HexLatticeRings: React.FC<HexLatticeRingsProps> = ({ rings, layerUniverses, universeLabel, onCell, onFillRing }) => {
    const sizes = latticeRingSizes(rings);

    return (
        <div className="lattice-ring-editor">
            <p className="lattice-legend">
                <i className="codicon codicon-info" aria-hidden="true"></i>
                Ring 0 is outermost. Position 0 starts at the top and runs clockwise; the last ring is the center.
            </p>
            <div className="lattice-ring-scroll">
                {sizes.map((size, ring) => (
                    <div key={`ring-${ring}`} className="lattice-ring-group" data-ring={ring}>
                        <button
                            type="button"
                            className="lattice-grid-header lattice-ring-fill"
                            onClick={() => onFillRing(ring)}
                            aria-label={`Fill ring ${ring} with the selected universe`}
                        >
                            <span>{ring === rings - 1 ? 'Center' : `Ring ${ring}`}</span>
                            <span className="lattice-ring-size">
                                {size} {size === 1 ? 'position' : 'positions'}
                            </span>
                        </button>
                        <div
                            className="lattice-ring-positions"
                            role="group"
                            aria-label={`${ring === rings - 1 ? 'Center' : `Ring ${ring}`} positions`}
                        >
                            {Array.from({ length: size }).map((__, theta) => (
                                <LatticeCellButton
                                    key={`ring-${ring}-theta-${theta}`}
                                    universeId={layerUniverses?.[ring]?.[theta] ?? 0}
                                    universeLabel={universeLabel}
                                    ariaLabel={`Ring ${ring}, position ${theta}`}
                                    caption={`${ring}.${theta}`}
                                    onClick={() => onCell(ring, theta)}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

interface LatticeCellButtonProps {
    universeId: number;
    universeLabel: (id: number) => string;
    ariaLabel: string;
    caption?: string;
    onClick: () => void;
}

/** One universe slot; shared tooltip and a 30 px minimum hit target. */
const LatticeCellButton: React.FC<LatticeCellButtonProps> = ({ universeId, universeLabel, ariaLabel, caption, onClick }) => {
    const description =
        universeId === 0 ? 'Unassigned — assign a non-root universe' : `Universe #${universeId} ${universeLabel(universeId)}`;
    const { onMouseEnter, onMouseLeave, tooltipElement } = useTooltip(`${ariaLabel}: ${description}`, 'top');

    return (
        <>
            <button
                type="button"
                className={`lattice-grid-cell${universeId === 0 ? ' empty' : ' filled'}`}
                onMouseEnter={onMouseEnter}
                onMouseLeave={onMouseLeave}
                onClick={onClick}
                aria-label={`${ariaLabel}: ${description}`}
            >
                <span className="lattice-cell-value">{universeId === 0 ? '–' : universeId}</span>
                {caption && <span className="lattice-cell-caption">{caption}</span>}
            </button>
            {tooltipElement}
        </>
    );
};
