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
import './slice-preview.css';

/**
 * Presentational 2D slice preview for the Viewer Settings slice section.
 *
 * The host owns extraction, mapping and state: it passes the already painted
 * RGBA buffer (see `viewer-core/slice-view.ts`) and this component only draws
 * it into a canvas through `ImageData`. No Theia imports, no global state,
 * no subscriptions; an undefined buffer renders a muted empty state.
 */
export interface SlicePreviewProps {
    /** Slice width in pixels/cells. */
    readonly width: number;
    /** Slice height in pixels/cells. */
    readonly height: number;
    /** Non-premultiplied RGBA buffer, `width * height * 4` bytes; undefined while unavailable. */
    readonly rgba?: Uint8ClampedArray;
    /** Bilinear upscaling for linearly sampled slices (default pixelated). */
    readonly smooth?: boolean;
    /** Accessible label for the canvas. */
    readonly label?: string;
    /** Muted placeholder text. */
    readonly emptyMessage?: string;
    /** Extra class on the preview root. */
    readonly className?: string;
}

export const SlicePreview: React.FC<SlicePreviewProps> = ({
    width,
    height,
    rgba,
    smooth = false,
    label = 'Slice preview',
    emptyMessage = 'No slice data',
    className
}) => {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);

    React.useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !rgba || width <= 0 || height <= 0) {
            return;
        }
        const expected = width * height * 4;
        if (rgba.length < expected) {
            return;
        }
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }
        canvas.width = width;
        canvas.height = height;
        // ImageData needs an exact-size buffer owned by this canvas; copying
        // also keeps a shared/subarray host buffer from pinning the pixel store.
        const pixels = new Uint8ClampedArray(expected);
        pixels.set(rgba.subarray(0, expected));
        context.putImageData(new ImageData(pixels, width, height), 0, 0);
    }, [width, height, rgba]);

    const rootClass = className ? `slice-preview ${className}` : 'slice-preview';
    if (!rgba || rgba.length === 0) {
        return (
            <div className={`${rootClass} slice-preview-empty`} role="img" aria-label={emptyMessage}>
                {emptyMessage}
            </div>
        );
    }
    return (
        <div className={rootClass}>
            <canvas
                ref={canvasRef}
                className={`slice-preview-canvas${smooth ? ' slice-preview-smooth' : ''}`}
                width={width}
                height={height}
                role="img"
                aria-label={label}
            />
        </div>
    );
};
