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

import { describe, expect, it } from 'vitest';
import {
    AnimationExportController,
    buildAnimationFilename,
    formatExportProgressLabel,
    isAnimationExportSupported,
    MEDIA_RECORDER_ABSENT_MESSAGE,
    planAnimationExportSteps,
    requireAnimationExportSupport,
    selectAnimationMimeType
} from './animation-export';

describe('animation export support probe', () => {
    it('reports support only when a MediaRecorder constructor is present', () => {
        expect(isAnimationExportSupported(function () {})).toBe(true);
        expect(isAnimationExportSupported(undefined)).toBe(false);
        expect(isAnimationExportSupported(undefined as unknown as object)).toBe(false);
    });

    it('throws a clear error (never a silent no-op) when MediaRecorder is absent', () => {
        expect(() => requireAnimationExportSupport(undefined)).toThrow(MEDIA_RECORDER_ABSENT_MESSAGE);
        expect(() => requireAnimationExportSupport(function () {})).not.toThrow();
    });

    it('prefers VP9 over VP8 over plain WebM', () => {
        expect(selectAnimationMimeType((mime) => mime === 'video/webm')).toBe('video/webm');
        expect(selectAnimationMimeType((mime) => mime !== 'video/webm;codecs=vp9')).toBe('video/webm;codecs=vp8');
        expect(selectAnimationMimeType(() => true)).toBe('video/webm;codecs=vp9');
        expect(selectAnimationMimeType(() => false)).toBeUndefined();
        expect(selectAnimationMimeType(undefined)).toBeUndefined();
    });

    it('skips MIME candidates whose probe throws', () => {
        const probe = (mime: string): boolean => {
            if (mime === 'video/webm;codecs=vp9') {
                throw new Error('no probe');
            }
            return true;
        };
        expect(selectAnimationMimeType(probe)).toBe('video/webm;codecs=vp8');
    });
});

describe('animation export step enumeration', () => {
    it('walks every loaded step in order', () => {
        expect(planAnimationExportSteps(3)).toEqual([0, 1, 2]);
        expect(planAnimationExportSteps(1)).toEqual([0]);
    });

    it('enumerates nothing for empty or invalid series', () => {
        expect(planAnimationExportSteps(0)).toEqual([]);
        expect(planAnimationExportSteps(-2)).toEqual([]);
        expect(planAnimationExportSteps(NaN)).toEqual([]);
    });
});

describe('AnimationExportController', () => {
    it('advances through the planned steps with progress', () => {
        const controller = new AnimationExportController(3);
        expect(controller.plannedSteps).toEqual([0, 1, 2]);
        expect(controller.isActive).toBe(false);
        controller.start();
        expect(controller.isActive).toBe(true);
        expect(controller.snapshot().currentStep).toBe(0);
        controller.completeStep(0);
        expect(controller.snapshot()).toMatchObject({ completedStepCount: 1, currentStep: 1 });
        expect(controller.progressFraction()).toBeCloseTo(1 / 3);
        controller.completeStep(1);
        controller.completeStep(2);
        expect(controller.snapshot().currentStep).toBeUndefined();
        controller.finish();
        expect(controller.snapshot().status).toBe('done');
        expect(controller.progressFraction()).toBe(1);
        expect(controller.isActive).toBe(false);
    });

    it('cancel sticks and ignores late step completions', () => {
        const controller = new AnimationExportController(3);
        controller.start();
        controller.completeStep(0);
        controller.cancel();
        expect(controller.snapshot().status).toBe('cancelled');
        expect(controller.isActive).toBe(false);
        controller.completeStep(1);
        controller.finish();
        expect(controller.snapshot()).toMatchObject({ status: 'cancelled', completedStepCount: 1 });
    });

    it('cancel from idle still reaches a terminal state', () => {
        const controller = new AnimationExportController(2);
        controller.cancel();
        expect(controller.snapshot().status).toBe('cancelled');
    });

    it('records failures with their message', () => {
        const controller = new AnimationExportController(2);
        controller.start();
        controller.fail('recorder stopped');
        expect(controller.snapshot()).toMatchObject({ status: 'error', error: 'recorder stopped' });
        expect(controller.isActive).toBe(false);
    });

    it('ignores transitions out of terminal states', () => {
        const controller = new AnimationExportController(1);
        controller.start();
        controller.finish();
        controller.start();
        controller.cancel();
        controller.completeStep(0);
        expect(controller.snapshot().status).toBe('done');
    });

    it('handles an empty series without progress', () => {
        const controller = new AnimationExportController(0);
        expect(controller.plannedSteps).toEqual([]);
        expect(controller.progressFraction()).toBe(0);
        controller.start();
        controller.finish();
        expect(controller.snapshot().status).toBe('done');
    });
});

describe('animation export presentation', () => {
    it('formats progress labels', () => {
        expect(formatExportProgressLabel(0, 3)).toBe('Step 1 of 3');
        expect(formatExportProgressLabel(2, 3)).toBe('Step 3 of 3');
        expect(formatExportProgressLabel(9, 3)).toBe('Step 3 of 3');
        expect(formatExportProgressLabel(0, 0)).toBe('No steps');
    });

    it('builds timestamped .webm filenames', () => {
        const now = new Date(2026, 9, 13, 9, 5, 7);
        expect(buildAnimationFilename('series', now)).toBe('series-20261013-090507.webm');
        expect(buildAnimationFilename(undefined, now)).toBe('exodus-animation-20261013-090507.webm');
    });
});
