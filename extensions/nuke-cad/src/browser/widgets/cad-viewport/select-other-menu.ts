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

/**
 * Select Other candidate list: the pure row model plus a thin imperative DOM
 * popover anchored at the context-menu pointer. Rows name the owning body and
 * show the face index and ray distance, so overlapping solids are
 * distinguishable before picking.
 *
 * @module nuke-cad/browser/widgets/cad-viewport
 */

import { type NukeCadDocument } from '../../../common/cad-document';
import { formatMeasureDistance } from './measure-tool';
import { type FacePickCandidate } from './face-picker';

/** Document subset needed for body-label resolution (undefined for script models). */
export type SelectOtherDocument = Pick<NukeCadDocument, 'bodies'>;

/** One rendered Select Other candidate. */
export interface SelectOtherRow {
    readonly solidId: number;
    readonly faceId: number;
    /** Body `label ?? name ?? id`, or `Solid <solidId>` when unmatched. */
    readonly bodyLabel: string;
    /** Muted face descriptor (`face <faceId>`). */
    readonly detail: string;
    /** Ray distance formatted with the viewport's length precision. */
    readonly distanceLabel: string;
}

/** The face identity handed back when a row is chosen. */
export interface SelectOtherPick {
    readonly solidId: number;
    readonly faceId: number;
}

/**
 * Map raycast candidates to display rows.
 *
 * Body labels come from the open document's `bodies`; script/STEP models have
 * no document and fall back to `Solid <solidId>`. `decimals` is the current
 * `nukeCad.lengthDecimals` value.
 */
export function buildSelectOtherRows(
    candidates: readonly FacePickCandidate[],
    document: SelectOtherDocument | undefined,
    decimals: number = 2
): SelectOtherRow[] {
    return candidates.map((candidate) => {
        const body = document?.bodies.find((entry) => entry.id === candidate.bodyId);
        return {
            solidId: candidate.solidId,
            faceId: candidate.faceId,
            bodyLabel: body !== undefined ? (body.label ?? body.name ?? body.id) : `Solid ${candidate.solidId}`,
            detail: `face ${candidate.faceId}`,
            distanceLabel: formatMeasureDistance(candidate.distance, decimals)
        };
    });
}

/**
 * Render the candidate popover at a container-relative anchor and invoke
 * `onPick` for the chosen face. Clamps the panel inside the container, closes
 * on any window pointerdown outside the popover or on Escape, and returns the
 * close function so the viewport cleanup can dismiss it too. A pick closes the
 * popover and hands focus back to the container, since the pressed button
 * leaves the DOM.
 */
export function openSelectOtherMenu(
    container: HTMLElement,
    rows: readonly SelectOtherRow[],
    anchor: { readonly x: number; readonly y: number },
    onPick: (pick: SelectOtherPick) => void
): () => void {
    const menu = document.createElement('div');
    menu.className = 'cad-select-other-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Select Other');

    const title = document.createElement('div');
    title.className = 'cad-select-other-title';
    title.textContent = 'Select Other';
    menu.appendChild(title);

    for (const row of rows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cad-select-other-row';
        button.setAttribute('role', 'menuitem');
        button.dataset.solidId = String(row.solidId);
        button.dataset.faceId = String(row.faceId);
        button.title = `${row.bodyLabel} — ${row.detail} (${row.distanceLabel})`;
        const icon = document.createElement('span');
        icon.className = 'codicon codicon-nuke-cad-cube cad-select-other-icon';
        button.appendChild(icon);
        const label = document.createElement('span');
        label.className = 'cad-select-other-label';
        label.textContent = row.bodyLabel;
        button.appendChild(label);
        const detail = document.createElement('span');
        detail.className = 'cad-select-other-detail';
        detail.textContent = row.detail;
        button.appendChild(detail);
        const distance = document.createElement('span');
        distance.className = 'cad-select-other-distance';
        distance.textContent = row.distanceLabel;
        button.appendChild(distance);
        button.addEventListener('click', () => {
            onPick({ solidId: row.solidId, faceId: row.faceId });
            close();
            container.focus({ preventScroll: true });
        });
        menu.appendChild(button);
    }

    container.appendChild(menu);
    // Clamp after layout so the fully-sized panel stays inside the canvas.
    const maxLeft = Math.max(0, container.clientWidth - menu.offsetWidth);
    const maxTop = Math.max(0, container.clientHeight - menu.offsetHeight);
    menu.style.left = `${Math.min(Math.max(anchor.x, 0), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(anchor.y, 0), maxTop)}px`;

    const onWindowPointerDown = (event: PointerEvent): void => {
        if (event.target instanceof Node && menu.contains(event.target)) {
            return;
        }
        close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.stopPropagation();
            close();
        }
    };
    // The popover outlives a pointer gesture: pointerdown (not click) closes,
    // and the popover's own presses must not trip the window listener.
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    window.addEventListener('pointerdown', onWindowPointerDown);
    window.addEventListener('keydown', onKeyDown, true);

    function close(): void {
        window.removeEventListener('pointerdown', onWindowPointerDown);
        window.removeEventListener('keydown', onKeyDown, true);
        menu.remove();
    }
    return close;
}
