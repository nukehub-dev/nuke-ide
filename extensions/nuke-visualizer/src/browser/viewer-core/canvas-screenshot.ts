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
 * Canvas screenshot helper for the native 3D viewer core.
 *
 * Replaces the trame screenshot button (`UIComponents.screenshot_button`,
 * server-side render to base64) with a client-side `toDataURL` download:
 * the widget renders locally, so the pixels are already on the canvas.
 *
 * Small DOM-touching module; the filename builder and data-URL capture are
 * pure and unit-tested, the anchor-click download is a thin DOM wrapper.
 */

/** Minimal canvas surface needed for a screenshot (real or offscreen). */
export interface ScreenshotCanvas {
    toDataURL(type?: string, quality?: number): string;
}

/** MIME type used for viewer screenshots. */
export const SCREENSHOT_MIME_TYPE = 'image/png';

/**
 * Capture a canvas as a data URL. The canvas must still hold its pixels
 * (created with `preserveDrawingBuffer: true` or captured synchronously
 * inside the render call).
 */
export function canvasToDataUrl(canvas: ScreenshotCanvas, mimeType: string = SCREENSHOT_MIME_TYPE): string {
    return canvas.toDataURL(mimeType);
}

function pad2(value: number): string {
    return value.toString().padStart(2, '0');
}

/**
 * Build a timestamped screenshot filename (`<prefix>-YYYYMMDD-HHmmss.png`).
 * Pure for testability; pass `now` explicitly in tests.
 */
export function buildScreenshotFilename(prefix = 'screenshot', now: Date = new Date()): string {
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(
        now.getMinutes()
    )}${pad2(now.getSeconds())}`;
    return `${prefix}-${stamp}.png`;
}

/**
 * Capture `canvas` and trigger a browser download.
 * Returns the filename used. Requires a DOM (throws otherwise).
 */
export function downloadCanvasScreenshot(canvas: ScreenshotCanvas, filename?: string): string {
    if (typeof document === 'undefined') {
        throw new Error('Canvas screenshot download requires a DOM.');
    }
    const name = filename ?? buildScreenshotFilename();
    const anchor = document.createElement('a');
    anchor.href = canvasToDataUrl(canvas);
    anchor.download = name;
    anchor.click();
    return name;
}
