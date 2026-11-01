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
 * NukeAI Welcome Bot
 *
 * A small, theme-aware mascot for the chat welcome surface. Its pupils follow
 * the pointer, the head drifts and tilts toward the cursor, the body floats,
 * and the eyes blink on a randomized schedule with occasional double blinks.
 * Pointer moves update CSS custom properties directly (coalesced through
 * requestAnimationFrame) instead of re-rendering React. The mascot is
 * decorative; autonomous motion stops under `prefers-reduced-motion`, while
 * user-driven eye tracking remains available.
 *
 * @module nuke-ai/browser/welcome
 */

import * as React from '@theia/core/shared/react';
import './nuke-ai-bot.css';

/** Maximum pupil displacement in SVG/CSS pixels. */
export const NUKE_AI_BOT_MAX_LOOK_PX = 3;

/** Pointer distance that reaches the maximum pupil displacement. */
const LOOK_RANGE_PX = 140;

/** Maximum head tilt in degrees. */
const MAX_TILT_DEG = 2.5;

/** Maximum head drift in pixels. */
const MAX_DRIFT_PX = 1.2;

/** Delay before the first autonomous blink. */
const FIRST_BLINK_MIN_MS = 2_400;
const FIRST_BLINK_MAX_MS = 4_000;

/** Shortest and longest gap between later autonomous blinks. */
const BLINK_MIN_MS = 4_000;
const BLINK_MAX_MS = 8_000;

/**
 * Convert a pointer position into a bounded pupil offset.
 *
 * @param pointerX - Pointer X in client coordinates.
 * @param pointerY - Pointer Y in client coordinates.
 * @param centerX - Bot center X in client coordinates.
 * @param centerY - Bot center Y in client coordinates.
 * @param maxOffset - Maximum displacement on either axis.
 * @returns The pupil offset, clamped per axis.
 */
export function computeBotLookOffset(
    pointerX: number,
    pointerY: number,
    centerX: number,
    centerY: number,
    maxOffset: number = NUKE_AI_BOT_MAX_LOOK_PX
): { x: number; y: number } {
    const clamp = (value: number): number => Math.max(-maxOffset, Math.min(maxOffset, value));
    return {
        x: clamp(((pointerX - centerX) / LOOK_RANGE_PX) * maxOffset),
        y: clamp(((pointerY - centerY) / LOOK_RANGE_PX) * maxOffset)
    };
}

/** Props for the decorative NukeAI mascot. */
export interface NukeAiBotProps {
    /** Optional rendered size in CSS pixels. Defaults to the CSS class size. */
    readonly size?: number;
    /** Optional extra class for placement in a host view. */
    readonly className?: string;
}

/** Decorative, pointer-aware NukeAI mascot. */
export function NukeAiBot({ size, className }: NukeAiBotProps = {}): React.ReactElement {
    const svgRef = React.useRef<SVGSVGElement>(null);

    React.useEffect(() => {
        const node = svgRef.current;
        if (!node || typeof window === 'undefined') {
            return undefined;
        }
        const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let frame = 0;
        let blinkTimer: ReturnType<typeof setTimeout> | undefined;
        let blinkEndTimer: ReturnType<typeof setTimeout> | undefined;
        let doubleBlinkTimer: ReturnType<typeof setTimeout> | undefined;
        let doubleBlinkEndTimer: ReturnType<typeof setTimeout> | undefined;

        const clearBlinkTimers = (): void => {
            if (blinkTimer !== undefined) {
                clearTimeout(blinkTimer);
            }
            if (blinkEndTimer !== undefined) {
                clearTimeout(blinkEndTimer);
            }
            if (doubleBlinkTimer !== undefined) {
                clearTimeout(doubleBlinkTimer);
            }
            if (doubleBlinkEndTimer !== undefined) {
                clearTimeout(doubleBlinkEndTimer);
            }
        };

        const blinkOnce = (double: boolean): void => {
            node.classList.add('nuke-ai-bot-blinking');
            blinkEndTimer = setTimeout(() => {
                node.classList.remove('nuke-ai-bot-blinking');
                if (double) {
                    doubleBlinkTimer = setTimeout(() => {
                        node.classList.add('nuke-ai-bot-blinking');
                        doubleBlinkEndTimer = setTimeout(() => node.classList.remove('nuke-ai-bot-blinking'), 100);
                    }, 140);
                }
            }, 110);
        };

        const scheduleBlink = (first: boolean): void => {
            const min = first ? FIRST_BLINK_MIN_MS : BLINK_MIN_MS;
            const max = first ? FIRST_BLINK_MAX_MS : BLINK_MAX_MS;
            blinkTimer = setTimeout(
                () => {
                    blinkOnce(Math.random() < 0.2);
                    scheduleBlink(false);
                },
                min + Math.random() * (max - min)
            );
        };

        let nextX = 0;
        let nextY = 0;
        let nextTilt = 0;
        let nextDriftX = 0;
        let nextDriftY = 0;
        const apply = (): void => {
            frame = 0;
            node.style.setProperty('--nuke-ai-bot-look-x', `${nextX}px`);
            node.style.setProperty('--nuke-ai-bot-look-y', `${nextY}px`);
            node.style.setProperty('--nuke-ai-bot-tilt', `${nextTilt}deg`);
            node.style.setProperty('--nuke-ai-bot-drift-x', `${nextDriftX}px`);
            node.style.setProperty('--nuke-ai-bot-drift-y', `${nextDriftY}px`);
        };
        const onPointerMove = (event: PointerEvent): void => {
            const rect = node.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) {
                return;
            }
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const offset = computeBotLookOffset(event.clientX, event.clientY, centerX, centerY);
            nextX = offset.x;
            nextY = offset.y;
            if (!reducedMotion) {
                nextTilt = Math.max(-1, Math.min(1, (event.clientX - centerX) / 220)) * MAX_TILT_DEG;
                nextDriftX = Math.max(-1, Math.min(1, (event.clientX - centerX) / 260)) * MAX_DRIFT_PX;
                nextDriftY = Math.max(-1, Math.min(1, (event.clientY - centerY) / 260)) * (MAX_DRIFT_PX * 0.7);
            }
            if (frame === 0) {
                frame = window.requestAnimationFrame(apply);
            }
        };

        window.addEventListener('pointermove', onPointerMove, { passive: true });
        if (!reducedMotion) {
            scheduleBlink(true);
        }
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            if (frame !== 0) {
                window.cancelAnimationFrame(frame);
            }
            clearBlinkTimers();
            node.classList.remove('nuke-ai-bot-blinking');
        };
    }, []);

    return (
        <svg
            ref={svgRef}
            className={className ? `nuke-ai-bot ${className}` : 'nuke-ai-bot'}
            style={size === undefined ? undefined : { width: `${size}px`, height: `${size}px` }}
            viewBox="0 0 96 96"
            shapeRendering="geometricPrecision"
            aria-hidden="true"
            focusable="false"
        >
            <ellipse className="nuke-ai-bot-shadow" cx="48" cy="84" rx="22" ry="3.5" />
            <g className="nuke-ai-bot-float">
                <g className="nuke-ai-bot-tilt">
                    <line className="nuke-ai-bot-antenna-line" x1="48" y1="18" x2="48" y2="28" />
                    <circle className="nuke-ai-bot-antenna-tip" cx="48" cy="14" r="3.5" />
                    <rect className="nuke-ai-bot-ear" x="14" y="42" width="7" height="16" rx="3.5" />
                    <rect className="nuke-ai-bot-ear" x="75" y="42" width="7" height="16" rx="3.5" />
                    <rect className="nuke-ai-bot-head" x="20" y="28" width="56" height="46" rx="14" />
                    <g className="nuke-ai-bot-blink">
                        <g className="nuke-ai-bot-look">
                            <circle className="nuke-ai-bot-eye-glow" cx="38" cy="49" r="7" />
                            <circle className="nuke-ai-bot-eye-glow" cx="58" cy="49" r="7" />
                            <circle className="nuke-ai-bot-eye" cx="38" cy="49" r="4" />
                            <circle className="nuke-ai-bot-eye" cx="58" cy="49" r="4" />
                        </g>
                    </g>
                    <rect className="nuke-ai-bot-mouth" x="42" y="61" width="12" height="2.5" rx="1.25" />
                </g>
            </g>
        </svg>
    );
}
