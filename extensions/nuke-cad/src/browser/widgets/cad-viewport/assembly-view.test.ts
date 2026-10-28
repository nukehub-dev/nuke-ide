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

import { describe, it, expect } from 'vitest';
import { MATE_TYPES, type AssemblyConnector, type AssemblyInstance, type MateType } from '../../../common/assembly-document';
import { connectorFrameFromDefinition, freeDofsForMateType, resolveMatePlacement } from '../../../common/assembly-placement';
import {
    assemblyConnectorTriads,
    assemblyDofRemaining,
    assemblyReuseKey,
    buildBomRows,
    freeDofHintText,
    instanceSolidIds,
    mateDofContribution,
    matePairKey,
    resolveConnectorPick,
    solveAssemblyTransforms,
    type AssemblyFaceInput
} from './assembly-view';
import type { AssemblySection } from '../../document/cad-document-store';

function instance(id: string, part: string, position: [number, number, number] = [0, 0, 0]): AssemblyInstance {
    return { id, part, placement: { position, orientation: [0, 0, 0, 1] } };
}

function connector(id: string, instanceId: string, origin: [number, number, number] = [0, 0, 0]): AssemblyConnector {
    return { id, instanceId, origin, xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
}

function assembly(): AssemblySection {
    return {
        instances: [instance('base', './base.nuke-cad'), instance('arm', './arm.nuke-cad')],
        connectors: [connector('c-base', 'base'), connector('c-arm', 'arm', [10, 0, 0])],
        mates: [{ id: 'm1', type: 'fixed', instanceA: 'base', connectorA: 'c-base', instanceB: 'arm', connectorB: 'c-arm' }],
        groundedInstanceId: 'base'
    };
}

function faceInput(): AssemblyFaceInput {
    return {
        fingerprint: { surfaceType: 'plane', area: 4, center: [0, 0, 0], normal: [0, 0, 1] },
        nodeCount: 4,
        triangleCount: 2,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])
    };
}

describe('assemblyReuseKey', () => {
    it('keys `<sourcePath>#<bodyId>::<faceFingerprint>`, never hash/positional ids', () => {
        const key = assemblyReuseKey('./bracket.nuke-cad', 'body-1', faceInput());
        expect(key.startsWith('./bracket.nuke-cad#body-1::')).toBe(true);
        expect(key).toContain('fp:');
        expect(key).not.toContain('hash');
        // Same source face in two instances shares the key (shared BufferGeometry).
        expect(assemblyReuseKey('./bracket.nuke-cad', 'body-1', faceInput())).toBe(key);
        // Different source parts never share geometry.
        expect(assemblyReuseKey('./other.nuke-cad', 'body-1', faceInput())).not.toBe(key);
    });
});

describe('solveAssemblyTransforms', () => {
    it('keeps the grounded placement and solves mates against the resolveMatePlacement oracle', () => {
        const doc = assembly();
        const solved = solveAssemblyTransforms(doc);
        expect(solved.get('base')).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        const frameA = connectorFrameFromDefinition(doc.connectors[0]);
        const frameB = connectorFrameFromDefinition(doc.connectors[1]);
        const oracle = resolveMatePlacement('fixed', frameA, frameB);
        expect(solved.get('arm')).toEqual(oracle.transform.matrix);
        // Closed form: R = identity here, t = pa − pb = (−10, 0, 0).
        expect(oracle.transform.position).toEqual([-10, 0, 0]);
    });

    it('leaves unmated non-grounded instances at their stored placement', () => {
        const doc = assembly();
        doc.instances.push(instance('free', './free.nuke-cad', [5, 5, 5]));
        const solved = solveAssemblyTransforms(doc);
        const free = solved.get('free')!;
        expect([free[3], free[7], free[11]]).toEqual([5, 5, 5]);
    });
});

describe('resolveConnectorPick', () => {
    it('guards against deleted instances/connectors (mirrors resolveCurvePick)', () => {
        const doc = assembly();
        expect(resolveConnectorPick(doc.connectors, doc.instances, 'c-base')?.id).toBe('c-base');
        expect(resolveConnectorPick(doc.connectors, doc.instances, 'deleted')).toBeUndefined();
        expect(resolveConnectorPick(doc.connectors, doc.instances, undefined)).toBeUndefined();
        expect(resolveConnectorPick(doc.connectors, doc.instances, '')).toBeUndefined();
        expect(
            resolveConnectorPick(
                doc.connectors,
                doc.instances.filter((i) => i.id !== 'base'),
                'c-base'
            )
        ).toBeUndefined();
    });
});

describe('mate dialog helpers (MATE_TYPES order, free-DOF hint)', () => {
    it('covers every MATE_TYPES entry with a matching free-DOF hint', () => {
        expect(MATE_TYPES).toEqual(['fixed', 'revolute', 'slider', 'cylindrical', 'ball', 'planar']);
        const hints = new Map<MateType, string>(MATE_TYPES.map((t) => [t, freeDofHintText(t)]));
        expect(hints.get('fixed')).toBe('Locks all 6 DOF');
        expect(hints.get('revolute')).toContain('rotation');
        expect(hints.get('planar')).toContain('translation');
        for (const type of MATE_TYPES) {
            expect(freeDofsForMateType(type).length).toBe(6 - mateDofContribution(type));
        }
    });

    it('orders pair keys independently of side', () => {
        expect(matePairKey('a', 'b')).toBe(matePairKey('b', 'a'));
    });
});

describe('buildBomRows + instanceSolidIds', () => {
    it('emits instance id, part source, mate type, DOF contribution', () => {
        const rows = buildBomRows(assembly());
        expect(rows).toEqual([
            { instanceId: 'base', part: './base.nuke-cad', grounded: true, mateType: 'fixed', dofContribution: 0 },
            { instanceId: 'arm', part: './arm.nuke-cad', grounded: false, mateType: 'fixed', dofContribution: 6 }
        ]);
    });

    it('maps assembly `<instanceId>/<bodyLabel>` selector keys to solids', () => {
        const selectorMap = { 'base/body-1': [1, 2], 'arm/body-1': [3], 'body-1': [9] };
        expect(instanceSolidIds(selectorMap, 'arm')).toEqual([3]);
        expect(instanceSolidIds(selectorMap, 'missing')).toEqual([]);
        expect(instanceSolidIds(undefined, 'arm')).toEqual([]);
    });

    it('counts remaining DOF grounded-first', () => {
        expect(assemblyDofRemaining(assembly())).toBe(0);
        const open = assembly();
        open.mates = [];
        expect(assemblyDofRemaining(open)).toBe(6);
    });
});

describe('assemblyConnectorTriads', () => {
    it('lifts every connector to its solved pose', () => {
        const triads = assemblyConnectorTriads(assembly());
        expect(triads.map((t) => t.connectorId).sort()).toEqual(['c-arm', 'c-base']);
        const arm = triads.find((t) => t.connectorId === 'c-arm')!;
        // Arm connector local origin (10,0,0) shifted by the solved (−10,0,0).
        expect(arm.origin[0]).toBeCloseTo(0, 9);
        expect(arm.origin[1]).toBeCloseTo(0, 9);
        expect(arm.origin[2]).toBeCloseTo(0, 9);
    });
});
