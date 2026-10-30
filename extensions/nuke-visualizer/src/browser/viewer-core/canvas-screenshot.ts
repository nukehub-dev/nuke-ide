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
 * Screenshot export pack: PNG/JPEG/WebP output with an optional quality, integer
 * super-sampling scale, and transparent-background capture for PNG/WebP.
 * `captureRendererScreenshot` temporarily resizes the three.js renderer
 * (`updateStyle=false`, so the CSS layout never moves), renders at the
 * requested scale, and restores size/aspect/clear-alpha in a `finally`.
 *
 * Small DOM-touching module; the filename builder, option resolution and
 * data-URL capture are pure and unit-tested, the anchor-click download is a
 * thin DOM wrapper, and the renderer helper is structural so it can be
 * exercised with a fake renderer (no `three` import).
 */

/** Output formats supported by the screenshot pack. */
export type ScreenshotFormat = 'png' | 'jpeg' | 'webp';

/** Integer render scale applied to the renderer size during capture. */
export type ScreenshotScale = 1 | 2 | 4;

/** Minimal canvas surface needed for a screenshot (real or offscreen). */
export interface ScreenshotCanvas {
    toDataURL(type?: string, quality?: number): string;
}

/** Screenshot request shared by the download helper, capture helper and export UI. */
export interface ScreenshotOptions {
    /** Output format; PNG when omitted. */
    readonly format?: ScreenshotFormat;
    /** JPEG/WebP encoder quality in `0..1` (clamped; ignored for PNG). */
    readonly quality?: number;
    /** Multiplier applied to the host dimensions; defaults to 1. */
    readonly scale?: ScreenshotScale;
    /** Transparent background for PNG/WebP (ignored for JPEG). */
    readonly transparent?: boolean;
}

/** Every supported output format, in menu order. */
export const SCREENSHOT_FORMATS: readonly ScreenshotFormat[] = ['png', 'jpeg', 'webp'];

/** Every supported render scale, in menu order. */
export const SCREENSHOT_SCALES: readonly ScreenshotScale[] = [1, 2, 4];

/** MIME type per output format. */
export const SCREENSHOT_MIME_TYPES: Readonly<Record<ScreenshotFormat, string>> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    webp: 'image/webp'
};

/** File extension per output format. */
export const SCREENSHOT_FILE_EXTENSIONS: Readonly<Record<ScreenshotFormat, string>> = {
    png: 'png',
    jpeg: 'jpeg',
    webp: 'webp'
};

/** MIME type used for default viewer screenshots (kept for existing callers). */
export const SCREENSHOT_MIME_TYPE = SCREENSHOT_MIME_TYPES.png;

/** MIME type for a screenshot format. */
export function screenshotMimeType(format: ScreenshotFormat = 'png'): string {
    return SCREENSHOT_MIME_TYPES[format];
}

/** True when the format can keep an alpha channel (everything but JPEG). */
export function screenshotFormatSupportsTransparency(format: ScreenshotFormat): boolean {
    return format !== 'jpeg';
}

/** Options after defaults, validation and format-specific coercion. */
export interface ResolvedScreenshotOptions {
    readonly format: ScreenshotFormat;
    readonly mimeType: string;
    /** Present only for JPEG/WebP with a finite quality. */
    readonly quality?: number;
    readonly scale: ScreenshotScale;
    /** Always false for JPEG, which has no alpha channel. */
    readonly transparent: boolean;
}

function isScreenshotFormat(value: string | undefined): value is ScreenshotFormat {
    return value !== undefined && (SCREENSHOT_FORMATS as readonly string[]).includes(value);
}

function isScreenshotScale(value: number | undefined): value is ScreenshotScale {
    return value !== undefined && (SCREENSHOT_SCALES as readonly number[]).includes(value);
}

/** Clamp a quality to `0..1`; non-finite values fall back to the encoder default. */
function normalizeQuality(quality: number | undefined): number | undefined {
    if (quality === undefined || !Number.isFinite(quality)) {
        return undefined;
    }
    return Math.min(1, Math.max(0, quality));
}

/**
 * Resolve a screenshot request: unknown formats/scales fall back to PNG/1x,
 * quality is clamped and dropped for PNG, and transparency is dropped for
 * JPEG. Shared by capture, download and the export menu.
 */
export function resolveScreenshotOptions(options: ScreenshotOptions = {}): ResolvedScreenshotOptions {
    const format = isScreenshotFormat(options.format) ? options.format : 'png';
    const scale = isScreenshotScale(options.scale) ? options.scale : 1;
    return {
        format,
        mimeType: screenshotMimeType(format),
        quality: format === 'png' ? undefined : normalizeQuality(options.quality),
        scale,
        transparent: screenshotFormatSupportsTransparency(format) && options.transparent === true
    };
}

/**
 * Capture a canvas as a data URL. The second argument accepts either a MIME
 * type (legacy call shape) or full screenshot options. PNG ignores quality.
 * The canvas must still hold its pixels (created with
 * `preserveDrawingBuffer: true` or captured synchronously inside the render
 * call).
 */
export function canvasToDataUrl(canvas: ScreenshotCanvas, mimeType?: string): string;
export function canvasToDataUrl(canvas: ScreenshotCanvas, options?: ScreenshotOptions): string;
export function canvasToDataUrl(canvas: ScreenshotCanvas, target: string | ScreenshotOptions = SCREENSHOT_MIME_TYPE): string {
    if (typeof target === 'string') {
        return canvas.toDataURL(target);
    }
    const resolved = resolveScreenshotOptions(target);
    return resolved.quality === undefined ? canvas.toDataURL(resolved.mimeType) : canvas.toDataURL(resolved.mimeType, resolved.quality);
}

function pad2(value: number): string {
    return value.toString().padStart(2, '0');
}

/**
 * Build a timestamped screenshot filename (`<prefix>-YYYYMMDD-HHmmss.<ext>`).
 * Pure for testability; pass `now` explicitly in tests. Format defaults to
 * PNG so the original two-argument call shape keeps working.
 */
export function buildScreenshotFilename(prefix?: string, now?: Date): string;
export function buildScreenshotFilename(prefix: string, now: Date, format: ScreenshotFormat): string;
export function buildScreenshotFilename(prefix = 'screenshot', now: Date = new Date(), format: ScreenshotFormat = 'png'): string {
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(
        now.getMinutes()
    )}${pad2(now.getSeconds())}`;
    const extension = SCREENSHOT_FILE_EXTENSIONS[format] ?? SCREENSHOT_FILE_EXTENSIONS.png;
    return `${prefix}-${stamp}.${extension}`;
}

/** Download request: screenshot options plus an optional explicit filename. */
export type ScreenshotDownloadOptions = ScreenshotOptions & { readonly filename?: string };

/**
 * Trigger a browser download for an already-captured data URL (for example
 * the return value of `captureRendererScreenshot`). Returns the filename
 * used. Requires a DOM (throws otherwise).
 *
 * The second argument accepts either an explicit filename or options; the
 * filename is derived from the format when omitted.
 */
export function downloadScreenshotDataUrl(dataUrl: string, filename?: string): string;
export function downloadScreenshotDataUrl(dataUrl: string, options?: ScreenshotDownloadOptions): string;
export function downloadScreenshotDataUrl(dataUrl: string, target?: string | ScreenshotDownloadOptions): string {
    if (typeof document === 'undefined') {
        throw new Error('Screenshot download requires a DOM.');
    }
    if (typeof target === 'string') {
        const anchor = document.createElement('a');
        anchor.href = dataUrl;
        anchor.download = target;
        anchor.click();
        return target;
    }
    const options = target ?? {};
    const resolved = resolveScreenshotOptions(options);
    const name = options.filename ?? buildScreenshotFilename('screenshot', new Date(), resolved.format);
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = name;
    anchor.click();
    return name;
}

/**
 * Capture `canvas` and trigger a browser download.
 * Returns the filename used. Requires a DOM (throws otherwise).
 *
 * The second argument accepts either an explicit filename (legacy call shape)
 * or options; the filename is derived from the format when omitted.
 */
export function downloadCanvasScreenshot(canvas: ScreenshotCanvas, filename?: string): string;
export function downloadCanvasScreenshot(canvas: ScreenshotCanvas, options?: ScreenshotDownloadOptions): string;
export function downloadCanvasScreenshot(canvas: ScreenshotCanvas, target?: string | ScreenshotDownloadOptions): string {
    if (typeof document === 'undefined') {
        throw new Error('Canvas screenshot download requires a DOM.');
    }
    if (typeof target === 'string') {
        return downloadScreenshotDataUrl(canvasToDataUrl(canvas), target);
    }
    const options = target ?? {};
    return downloadScreenshotDataUrl(canvasToDataUrl(canvas, options), options);
}

/** Minimal 2D vector carrier matching three.js `Vector2` (`getSize` out-param). */
export interface ScreenshotSize {
    x: number;
    y: number;
    set(x: number, y: number): ScreenshotSize;
}

/**
 * Structural slice of `THREE.WebGLRenderer` used for capture. Typing it here
 * (instead of importing `three`) keeps the helper unit-testable with a fake.
 */
export interface ScreenshotRenderer {
    readonly domElement: ScreenshotCanvas;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    getSize(target: ScreenshotSize): ScreenshotSize;
    render(scene: unknown, camera: unknown): void;
    setClearAlpha?(alpha: number): void;
    getClearAlpha?(): number;
}

/** Structural slice of a three.js perspective/orthographic camera. */
export interface ScreenshotCamera {
    /** Perspective cameras carry an aspect ratio; orthographic ones do not. */
    aspect?: number;
    updateProjectionMatrix?(): void;
}

/** Structural slice of a three.js scene: transparent capture must drop the painted backdrop. */
export interface ScreenshotScene {
    background?: unknown;
}

/** Sized host element (the widget viewarea) that owns the renderer canvas. */
export interface ScreenshotHost {
    readonly clientWidth: number;
    readonly clientHeight: number;
}

function createSizeCarrier(): ScreenshotSize {
    const size: ScreenshotSize = {
        x: 0,
        y: 0,
        set(x: number, y: number): ScreenshotSize {
            size.x = x;
            size.y = y;
            return size;
        }
    };
    return size;
}

function positiveDimension(...candidates: number[]): number {
    for (const candidate of candidates) {
        if (Number.isFinite(candidate) && candidate > 0) {
            return Math.round(candidate);
        }
    }
    return 1;
}

/**
 * Render `scene` at `host` size × `options.scale` and return the data URL.
 *
 * Saves the renderer size, camera aspect and clear alpha, resizes with
 * `updateStyle=false` (CSS size untouched), renders at the higher resolution,
 * captures, and restores everything in a `finally` — a throwing render cannot
 * leave the viewer at the wrong size. Transparent capture needs a renderer
 * created with `alpha: true` and both `getClearAlpha`/`setClearAlpha`; the
 * scene background is nulled (and restored) so the alpha actually shows.
 *
 * Restoring the size clears the drawing buffer, so the host must repaint with
 * its own scene renderer afterwards (multi-pass viewers must reuse their full
 * render path, which this helper cannot reproduce).
 */
export function captureRendererScreenshot(
    renderer: ScreenshotRenderer,
    scene: ScreenshotScene,
    camera: ScreenshotCamera,
    host: ScreenshotHost,
    options: ScreenshotOptions = {}
): string {
    const resolved = resolveScreenshotOptions(options);
    const savedSize = renderer.getSize(createSizeCarrier());
    const savedWidth = positiveDimension(savedSize.x);
    const savedHeight = positiveDimension(savedSize.y);
    const savedAspect = camera.aspect;
    const canAdjustAlpha = typeof renderer.setClearAlpha === 'function' && typeof renderer.getClearAlpha === 'function';
    const savedAlpha = canAdjustAlpha ? renderer.getClearAlpha!() : undefined;
    const savedBackground = resolved.transparent ? scene.background : undefined;
    const targetWidth = positiveDimension(host.clientWidth, savedWidth) * resolved.scale;
    const targetHeight = positiveDimension(host.clientHeight, savedHeight) * resolved.scale;
    let alphaChanged = false;
    try {
        renderer.setSize(targetWidth, targetHeight, false);
        if (savedAspect !== undefined) {
            camera.aspect = targetWidth / targetHeight;
            camera.updateProjectionMatrix?.();
        }
        if (resolved.transparent) {
            scene.background = null;
        }
        if (resolved.transparent && canAdjustAlpha) {
            renderer.setClearAlpha!(0);
            alphaChanged = true;
        }
        renderer.render(scene, camera);
        return canvasToDataUrl(renderer.domElement, resolved);
    } finally {
        renderer.setSize(savedWidth, savedHeight, false);
        if (savedAspect !== undefined) {
            camera.aspect = savedAspect;
            camera.updateProjectionMatrix?.();
        }
        if (alphaChanged) {
            renderer.setClearAlpha!(savedAlpha!);
        }
        if (resolved.transparent) {
            scene.background = savedBackground;
        }
    }
}

/**
 * Copy an already-captured image data URL to the clipboard. Best-effort:
 * browsers without `ClipboardItem`/`navigator.clipboard.write` throw a
 * descriptive error so hosts can fall back to a download with a visible note.
 */
export async function copyScreenshotDataUrl(dataUrl: string): Promise<void> {
    if (typeof navigator === 'undefined' || navigator.clipboard?.write === undefined || typeof ClipboardItem === 'undefined') {
        throw new Error('Image clipboard is not available in this browser shell.');
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}
