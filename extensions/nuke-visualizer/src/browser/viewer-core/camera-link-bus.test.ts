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
 * Tests for the viewer-core camera link bus (no DOM, no three.js): fan-out
 * to every subscriber of one file key, the same-file-only rule, the
 * origin-exclusion + echo-suppression loop guards, unsubscribe/dispose, and
 * the pose-to-direction derivation the subscribers apply.
 */

import { describe, expect, it } from 'vitest';
import { cameraPoseDirection, createCameraLinkBus, type CameraLinkPose } from './camera-link-bus';

const POSE_A: CameraLinkPose = {
    position: [3, 4, 0],
    target: [0, 0, 0]
};

const POSE_B: CameraLinkPose = {
    position: [0, 0, 10],
    target: [1, 2, 3]
};

describe('camera link bus fan-out', () => {
    it('delivers one publish to every other subscriber of the same key', () => {
        const bus = createCameraLinkBus();
        const receivedA: CameraLinkPose[] = [];
        const receivedB: CameraLinkPose[] = [];
        const receivedC: CameraLinkPose[] = [];
        const a = bus.link('tally.vti', (pose) => receivedA.push(pose));
        bus.link('tally.vti', (pose) => receivedB.push(pose));
        bus.link('tally.vti', (pose) => receivedC.push(pose));
        a.publish(POSE_A);
        // Origin exclusion: the publisher never hears its own publish.
        expect(receivedA).toHaveLength(0);
        expect(receivedB).toHaveLength(1);
        expect(receivedC).toHaveLength(1);
        expect(receivedB[0]).toEqual(POSE_A);
        expect(receivedC[0]).toEqual(POSE_A);
        a.dispose();
    });

    it('hands each listener its own copy (a mutating listener cannot corrupt the bus)', () => {
        const bus = createCameraLinkBus();
        const seen: CameraLinkPose[] = [];
        const mutating = bus.link('tally.vti', (pose) => {
            seen.push({ position: [...pose.position], target: [...pose.target] });
            (pose.position as unknown as [number, number, number])[0] = 999;
        });
        const follower: CameraLinkPose[] = [];
        const other = bus.link('tally.vti', (pose) => follower.push({ position: [...pose.position], target: [...pose.target] }));
        const publisher = bus.link('tally.vti', () => undefined);
        publisher.publish(POSE_A);
        // Both listeners saw the true pose despite the first mutating its copy.
        expect(seen).toEqual([POSE_A]);
        expect(follower).toEqual([POSE_A]);
        // The bus memory is uncorrupted: a later pose still dispatches truly.
        publisher.publish(POSE_B);
        expect(seen[1]).toEqual(POSE_B);
        expect(follower[1]).toEqual(POSE_B);
        mutating.dispose();
        other.dispose();
        publisher.dispose();
    });
});

describe('camera link bus same-file-only rule', () => {
    it('never delivers across different file keys', () => {
        const bus = createCameraLinkBus();
        const received: CameraLinkPose[] = [];
        const other = bus.link('other.vti', (pose) => received.push(pose));
        const publisher = bus.link('tally.vti', () => undefined);
        publisher.publish(POSE_A);
        expect(received).toHaveLength(0);
        other.dispose();
        publisher.dispose();
    });

    it('hands an inert endpoint to an empty key (no bus-wide broadcast)', () => {
        const bus = createCameraLinkBus();
        const received: CameraLinkPose[] = [];
        const keyed = bus.link('tally.vti', (pose) => received.push(pose));
        const keyless = bus.link('', (pose) => received.push(pose));
        // Must not throw and must not deliver anywhere.
        keyless.publish(POSE_A);
        expect(received).toHaveLength(0);
        keyed.dispose();
        keyless.dispose();
    });
});

describe('camera link bus echo suppression', () => {
    it('terminates a subscriber rebroadcast instead of looping', () => {
        const bus = createCameraLinkBus();
        const counts = { rebroadcaster: 0, bystander: 0 };
        const rebroadcaster = bus.link('tally.vti', (pose) => {
            counts.rebroadcaster++;
            // Naive echo: republish exactly what arrived (the widget's
            // applying-flag makes this unnecessary; the bus still survives it).
            rebroadcaster.publish(pose);
        });
        const bystander = bus.link('tally.vti', () => counts.bystander++);
        const origin = bus.link('tally.vti', () => undefined);
        // The initial publish reaches both listeners; the echo dies in the bus.
        origin.publish(POSE_A);
        expect(counts.rebroadcaster).toBe(1);
        expect(counts.bystander).toBe(1);
        origin.dispose();
        rebroadcaster.dispose();
        bystander.dispose();
    });

    it('still delivers a genuinely new pose after an echo', () => {
        const bus = createCameraLinkBus();
        const received: CameraLinkPose[] = [];
        const echoing = bus.link('tally.vti', (pose) => {
            received.push(pose);
            echoing.publish(pose);
        });
        const origin = bus.link('tally.vti', () => undefined);
        origin.publish(POSE_A);
        expect(received).toHaveLength(1);
        origin.publish(POSE_B);
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual(POSE_B);
        origin.dispose();
        echoing.dispose();
    });
});

describe('camera link bus unsubscribe', () => {
    it('stops delivery after dispose and tolerates double dispose', () => {
        const bus = createCameraLinkBus();
        const received: CameraLinkPose[] = [];
        const subscriber = bus.link('tally.vti', (pose) => received.push(pose));
        const publisher = bus.link('tally.vti', () => undefined);
        publisher.publish(POSE_A);
        expect(received).toHaveLength(1);
        subscriber.dispose();
        subscriber.dispose();
        publisher.publish(POSE_B);
        expect(received).toHaveLength(1);
        publisher.dispose();
    });

    it('publishing with no subscribers is a safe no-op', () => {
        const bus = createCameraLinkBus();
        const lonely = bus.link('tally.vti', () => undefined);
        lonely.dispose();
        expect(() => lonely.publish(POSE_A)).not.toThrow();
    });
});

describe('camera pose direction', () => {
    it('derives the normalized target-to-position direction', () => {
        expect(cameraPoseDirection(POSE_A)).toEqual([0.6, 0.8, 0]);
    });

    it('returns undefined for a zero-length offset (camera on the target)', () => {
        expect(cameraPoseDirection({ position: [1, 2, 3], target: [1, 2, 3] })).toBeUndefined();
    });

    it('returns undefined for non-finite components', () => {
        expect(cameraPoseDirection({ position: [NaN, 0, 0], target: [0, 0, 0] })).toBeUndefined();
        expect(cameraPoseDirection({ position: [1, 0, 0], target: [Infinity, 0, 0] })).toBeUndefined();
    });
});
