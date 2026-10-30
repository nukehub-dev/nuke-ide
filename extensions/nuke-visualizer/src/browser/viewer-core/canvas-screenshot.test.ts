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

import type * as THREE from 'three';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
    SCREENSHOT_FILE_EXTENSIONS,
    SCREENSHOT_FORMATS,
    SCREENSHOT_MIME_TYPE,
    SCREENSHOT_MIME_TYPES,
    SCREENSHOT_SCALES,
    buildScreenshotFilename,
    canvasToDataUrl,
    captureRendererScreenshot,
    downloadCanvasScreenshot,
    downloadScreenshotDataUrl,
    resolveScreenshotOptions,
    screenshotFormatSupportsTransparency,
    screenshotMimeType,
    type ScreenshotCamera,
    type ScreenshotFormat,
    type ScreenshotHost,
    type ScreenshotRenderer,
    type ScreenshotScale,
    type ScreenshotSize
} from './canvas-screenshot';

/** Compile-time guard: a real three.js renderer/scene/camera must satisfy the structural slice. */
function captureFromThree(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    host: ScreenshotHost
): string {
    return captureRendererScreenshot(renderer, scene, camera, host, { format: 'png', scale: 2 });
}

function captureFromThreeOrtho(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.OrthographicCamera,
    host: ScreenshotHost
): string {
    return captureRendererScreenshot(renderer, scene, camera, host, { format: 'webp', transparent: true });
}

type ToDataUrlMock = Mock<(type?: string, quality?: number) => string>;
type SetSizeMock = Mock<(width: number, height: number, updateStyle?: boolean) => void>;
type GetSizeMock = Mock<(target: ScreenshotSize) => ScreenshotSize>;
type RenderMock = Mock<(...args: unknown[]) => void>;
type SetClearAlphaMock = Mock<(alpha: number) => void>;
type GetClearAlphaMock = Mock<() => number>;

interface FakeRenderer extends ScreenshotRenderer {
    readonly toDataURL: ToDataUrlMock;
    readonly setSize: SetSizeMock;
    readonly getSize: GetSizeMock;
    readonly render: RenderMock;
    readonly setClearAlpha?: SetClearAlphaMock;
    readonly getClearAlpha?: GetClearAlphaMock;
}

function createFakeRenderer(
    width = 400,
    height = 300,
    options: { readonly clearAlpha?: number; readonly withoutAlphaControl?: boolean } = {}
): FakeRenderer {
    const size: ScreenshotSize = {
        x: width,
        y: height,
        set(x: number, y: number): ScreenshotSize {
            size.x = x;
            size.y = y;
            return size;
        }
    };
    const toDataURL: ToDataUrlMock = vi.fn(() => 'data:image/png;base64,AAA');
    const setSize: SetSizeMock = vi.fn((nextWidth: number, nextHeight: number) => {
        size.x = nextWidth;
        size.y = nextHeight;
    });
    const getSize: GetSizeMock = vi.fn((target: ScreenshotSize) => target.set(size.x, size.y));
    const render: RenderMock = vi.fn();
    if (options.withoutAlphaControl) {
        return { domElement: { toDataURL }, setSize, getSize, render, toDataURL };
    }
    const clearAlpha = options.clearAlpha ?? 0.25;
    const setClearAlpha: SetClearAlphaMock = vi.fn();
    const getClearAlpha: GetClearAlphaMock = vi.fn(() => clearAlpha);
    return { domElement: { toDataURL }, setSize, getSize, render, setClearAlpha, getClearAlpha, toDataURL };
}

function createCamera(aspect: number | undefined): ScreenshotCamera & { updateProjectionMatrix: Mock<() => void> } {
    return {
        aspect,
        updateProjectionMatrix: vi.fn()
    };
}

describe('screenshot formats and MIME types', () => {
    it('lists every supported format and scale in menu order', () => {
        expect([...SCREENSHOT_FORMATS]).toEqual(['png', 'jpeg', 'webp']);
        expect([...SCREENSHOT_SCALES]).toEqual([1, 2, 4]);
    });

    it('maps formats onto their canvas MIME types', () => {
        expect(screenshotMimeType('png')).toBe('image/png');
        expect(screenshotMimeType('jpeg')).toBe('image/jpeg');
        expect(screenshotMimeType('webp')).toBe('image/webp');
        expect(screenshotMimeType()).toBe('image/png');
        expect(SCREENSHOT_MIME_TYPE).toBe(SCREENSHOT_MIME_TYPES.png);
        expect(SCREENSHOT_MIME_TYPES).toEqual({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });
    });

    it('uses conventional file extensions', () => {
        expect(SCREENSHOT_FILE_EXTENSIONS).toEqual({ png: 'png', jpeg: 'jpeg', webp: 'webp' });
    });

    it('only drops transparency for JPEG', () => {
        expect(screenshotFormatSupportsTransparency('png')).toBe(true);
        expect(screenshotFormatSupportsTransparency('webp')).toBe(true);
        expect(screenshotFormatSupportsTransparency('jpeg')).toBe(false);
    });
});

describe('resolveScreenshotOptions', () => {
    it('defaults to opaque PNG at 1x', () => {
        expect(resolveScreenshotOptions()).toEqual({
            format: 'png',
            mimeType: 'image/png',
            quality: undefined,
            scale: 1,
            transparent: false
        });
    });

    it('clamps quality for JPEG and WebP', () => {
        expect(resolveScreenshotOptions({ format: 'jpeg', quality: 1.4 }).quality).toBe(1);
        expect(resolveScreenshotOptions({ format: 'webp', quality: -0.2 }).quality).toBe(0);
        expect(resolveScreenshotOptions({ format: 'webp', quality: 0.75 }).quality).toBe(0.75);
        expect(resolveScreenshotOptions({ format: 'jpeg', quality: Number.NaN }).quality).toBeUndefined();
    });

    it('ignores quality for PNG and transparency for JPEG', () => {
        expect(resolveScreenshotOptions({ format: 'png', quality: 0.5, transparent: true })).toMatchObject({
            quality: undefined,
            transparent: true
        });
        expect(resolveScreenshotOptions({ format: 'jpeg', transparent: true }).transparent).toBe(false);
        expect(resolveScreenshotOptions({ format: 'webp', transparent: true }).transparent).toBe(true);
    });

    it('falls back for unknown runtime values', () => {
        const format = 'gif' as ScreenshotFormat;
        const scale = 3 as ScreenshotScale;
        expect(resolveScreenshotOptions({ format, scale })).toMatchObject({ format: 'png', scale: 1 });
        expect(resolveScreenshotOptions({ scale: 4 }).scale).toBe(4);
    });
});

describe('buildScreenshotFilename', () => {
    const now = new Date(2026, 8, 6, 12, 30, 5);

    it('keeps the original PNG filename shape', () => {
        expect(buildScreenshotFilename('mesh', now)).toBe('mesh-20260906-123005.png');
        expect(buildScreenshotFilename('screenshot', now)).toBe('screenshot-20260906-123005.png');
        expect(buildScreenshotFilename(undefined, now)).toBe('screenshot-20260906-123005.png');
    });

    it('uses the requested format extension', () => {
        expect(buildScreenshotFilename('mesh', now, 'png')).toBe('mesh-20260906-123005.png');
        expect(buildScreenshotFilename('mesh', now, 'jpeg')).toBe('mesh-20260906-123005.jpeg');
        expect(buildScreenshotFilename('mesh', now, 'webp')).toBe('mesh-20260906-123005.webp');
    });

    it('zero-pads every timestamp field', () => {
        expect(buildScreenshotFilename('frame', new Date(2026, 0, 2, 3, 4, 5), 'webp')).toBe('frame-20260102-030405.webp');
    });
});

describe('canvasToDataUrl', () => {
    const canvas = () => ({ toDataURL: vi.fn(() => 'data:image/png;base64,AAA') });

    it('keeps the legacy PNG call shape (one argument)', () => {
        const target = canvas();
        expect(canvasToDataUrl(target)).toBe('data:image/png;base64,AAA');
        expect(target.toDataURL).toHaveBeenCalledWith(SCREENSHOT_MIME_TYPE);
    });

    it('still accepts an explicit MIME type string', () => {
        const target = canvas();
        canvasToDataUrl(target, 'image/webp');
        expect(target.toDataURL).toHaveBeenCalledWith('image/webp');
    });

    it('passes the format MIME type and clamped quality for JPEG/WebP', () => {
        const jpeg = canvas();
        canvasToDataUrl(jpeg, { format: 'jpeg', quality: 0.8 });
        expect(jpeg.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.8);

        const webp = canvas();
        canvasToDataUrl(webp, { format: 'webp', quality: 2 });
        expect(webp.toDataURL).toHaveBeenCalledWith('image/webp', 1);
    });

    it('never forwards quality for PNG', () => {
        const target = canvas();
        canvasToDataUrl(target, { format: 'png', quality: 0.4 });
        expect(target.toDataURL).toHaveBeenCalledTimes(1);
        expect(target.toDataURL).toHaveBeenCalledWith('image/png');
    });
});

describe('screenshot downloads', () => {
    const originalDocument = globalThis.document;

    afterEach(() => {
        vi.useRealTimers();
        if (originalDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
        } else {
            (globalThis as { document?: unknown }).document = originalDocument;
        }
    });

    function stubAnchor(): { href: string; download: string; click: ReturnType<typeof vi.fn> } {
        const anchor = { href: '', download: '', click: vi.fn() };
        (globalThis as { document?: unknown }).document = { createElement: vi.fn(() => anchor) };
        return anchor;
    }

    it('keeps the legacy explicit-filename PNG download', () => {
        const anchor = stubAnchor();
        const canvas = { toDataURL: vi.fn(() => 'data:image/png;base64,AAA') };
        const name = downloadCanvasScreenshot(canvas, 'mesh-20260906-123005.png');
        expect(name).toBe('mesh-20260906-123005.png');
        expect(anchor.href).toBe('data:image/png;base64,AAA');
        expect(anchor.download).toBe('mesh-20260906-123005.png');
        expect(anchor.click).toHaveBeenCalledTimes(1);
        expect(canvas.toDataURL).toHaveBeenCalledWith('image/png');
    });

    it('plumbs format, quality and an explicit filename', () => {
        const anchor = stubAnchor();
        const canvas = { toDataURL: vi.fn(() => 'data:image/webp;base64,BBB') };
        const name = downloadCanvasScreenshot(canvas, { format: 'webp', quality: 0.6, filename: 'view.webp' });
        expect(name).toBe('view.webp');
        expect(anchor.href).toBe('data:image/webp;base64,BBB');
        expect(anchor.download).toBe('view.webp');
        expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', 0.6);
    });

    it('derives a timestamped filename from the format when omitted', () => {
        stubAnchor();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 8, 6, 12, 30, 5));
        const canvas = { toDataURL: vi.fn(() => 'data:image/jpeg;base64,CCC') };
        expect(downloadCanvasScreenshot(canvas, { format: 'jpeg' })).toBe('screenshot-20260906-123005.jpeg');
        expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg');
    });

    it('throws without a DOM', () => {
        delete (globalThis as { document?: unknown }).document;
        expect(() => downloadCanvasScreenshot({ toDataURL: () => '' })).toThrow('requires a DOM');
    });

    it('downloads an already-captured data URL with an explicit filename', () => {
        const anchor = stubAnchor();
        const name = downloadScreenshotDataUrl('data:image/png;base64,ZZZ', 'capture.png');
        expect(name).toBe('capture.png');
        expect(anchor.href).toBe('data:image/png;base64,ZZZ');
        expect(anchor.download).toBe('capture.png');
        expect(anchor.click).toHaveBeenCalledTimes(1);
    });

    it('derives the data-URL filename from the format', () => {
        const anchor = stubAnchor();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 8, 6, 12, 30, 5));
        const name = downloadScreenshotDataUrl('data:image/webp;base64,ZZZ', { format: 'webp', quality: 0.7 });
        expect(name).toBe('screenshot-20260906-123005.webp');
        expect(anchor.download).toBe('screenshot-20260906-123005.webp');
        expect(anchor.href).toBe('data:image/webp;base64,ZZZ');
    });

    it('throws without a DOM when downloading a captured data URL', () => {
        delete (globalThis as { document?: unknown }).document;
        expect(() => downloadScreenshotDataUrl('data:image/png;base64,ZZZ')).toThrow('requires a DOM');
    });
});

describe('captureRendererScreenshot', () => {
    it('renders at scale, then restores size, aspect and clear alpha', () => {
        const renderer = createFakeRenderer(400, 300, { clearAlpha: 0.25 });
        const camera = createCamera(1.5);
        const scene = { name: 'scene', background: 'theme-background' as unknown };
        let backgroundDuringRender: unknown = 'not-rendered';
        renderer.render.mockImplementation(() => {
            backgroundDuringRender = scene.background;
        });
        const dataUrl = captureRendererScreenshot(
            renderer,
            scene,
            camera,
            { clientWidth: 800, clientHeight: 600 },
            { format: 'png', scale: 2, transparent: true }
        );

        expect(dataUrl).toBe('data:image/png;base64,AAA');
        expect(backgroundDuringRender).toBeNull();
        expect(scene.background).toBe('theme-background');
        expect(renderer.setSize).toHaveBeenNthCalledWith(1, 1600, 1200, false);
        expect(renderer.setSize).toHaveBeenNthCalledWith(2, 400, 300, false);
        expect(renderer.getSize).toHaveBeenCalledTimes(1);
        expect(renderer.setClearAlpha).toHaveBeenNthCalledWith(1, 0);
        expect(renderer.setClearAlpha).toHaveBeenNthCalledWith(2, 0.25);
        expect(renderer.render).toHaveBeenCalledTimes(1);
        expect(renderer.render).toHaveBeenCalledWith(scene, camera);
        expect(renderer.toDataURL).toHaveBeenCalledWith('image/png');
        expect(camera.aspect).toBe(1.5);
        expect(camera.updateProjectionMatrix).toHaveBeenCalledTimes(2);
    });

    it('plumbs JPEG quality and never touches clear alpha or the scene background for JPEG', () => {
        const renderer = createFakeRenderer();
        const camera = createCamera(1.25);
        const scene = { background: 'theme-background' as unknown };
        let backgroundDuringRender: unknown = 'not-rendered';
        renderer.render.mockImplementation(() => {
            backgroundDuringRender = scene.background;
        });
        captureRendererScreenshot(
            renderer,
            scene,
            camera,
            { clientWidth: 800, clientHeight: 600 },
            { format: 'jpeg', quality: 0.6, transparent: true }
        );

        expect(renderer.setSize).toHaveBeenNthCalledWith(1, 800, 600, false);
        expect(renderer.setClearAlpha).not.toHaveBeenCalled();
        expect(backgroundDuringRender).toBe('theme-background');
        expect(scene.background).toBe('theme-background');
        expect(renderer.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.6);
        expect(camera.aspect).toBe(1.25);
    });

    it('restores renderer state when render throws', () => {
        const renderer = createFakeRenderer(640, 480, { clearAlpha: 0.5 });
        renderer.render.mockImplementation(() => {
            throw new Error('render failed');
        });
        const camera = createCamera(1.75);
        const scene = { background: 'theme-background' as unknown };

        expect(() =>
            captureRendererScreenshot(
                renderer,
                scene,
                camera,
                { clientWidth: 320, clientHeight: 240 },
                { format: 'webp', scale: 4, transparent: true }
            )
        ).toThrow('render failed');

        expect(renderer.setSize).toHaveBeenNthCalledWith(1, 1280, 960, false);
        expect(renderer.setSize).toHaveBeenNthCalledWith(2, 640, 480, false);
        expect(renderer.setClearAlpha).toHaveBeenNthCalledWith(1, 0);
        expect(renderer.setClearAlpha).toHaveBeenNthCalledWith(2, 0.5);
        expect(renderer.toDataURL).not.toHaveBeenCalled();
        expect(camera.aspect).toBe(1.75);
        expect(scene.background).toBe('theme-background');
    });

    it('captures without alpha control when the renderer cannot restore it', () => {
        const renderer = createFakeRenderer(320, 200, { withoutAlphaControl: true });
        const camera = createCamera(1.5);
        const dataUrl = captureRendererScreenshot(
            renderer,
            {},
            camera,
            { clientWidth: 320, clientHeight: 200 },
            { format: 'png', transparent: true }
        );

        expect(dataUrl).toBe('data:image/png;base64,AAA');
        expect(renderer.setSize).toHaveBeenNthCalledWith(1, 320, 200, false);
        expect(renderer.setSize).toHaveBeenNthCalledWith(2, 320, 200, false);
        expect(renderer.setClearAlpha).toBeUndefined();
    });

    it('falls back to the current renderer size when the host is not laid out, and skips ortho aspect', () => {
        const renderer = createFakeRenderer(320, 200);
        const camera = createCamera(undefined);
        captureRendererScreenshot(renderer, {}, camera, { clientWidth: 0, clientHeight: 0 }, { format: 'png', scale: 4 });

        expect(renderer.setSize).toHaveBeenNthCalledWith(1, 1280, 800, false);
        expect(renderer.setSize).toHaveBeenNthCalledWith(2, 320, 200, false);
        expect(camera.aspect).toBeUndefined();
        expect(camera.updateProjectionMatrix).not.toHaveBeenCalled();
    });

    it('types cleanly against a three.js renderer/scene/camera', () => {
        expect(typeof captureFromThree).toBe('function');
        expect(typeof captureFromThreeOrtho).toBe('function');
    });
});
