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
import {
    createAssemblyDocument,
    orthonormalizeConnectorAxes,
    validateAssemblyDocument,
    instancePlacementToMatrix,
    normalizeQuaternion,
    type AssemblyDocument,
    type Vec3
} from './assembly-document';

function instance(id: string, part = `./${id}.nuke-cad`) {
    return { id, part, placement: { position: [0, 0, 0] as Vec3, orientation: [0, 0, 0, 1] as [number, number, number, number] } };
}

function connector(id: string, instanceId: string, origin: Vec3 = [0, 0, 0]) {
    return { id, instanceId, origin, xAxis: [1, 0, 0] as Vec3, yAxis: [0, 1, 0] as Vec3 };
}

function validDocument(): AssemblyDocument {
    return {
        version: 1,
        name: 'pump',
        instances: [instance('housing'), instance('shaft')],
        connectors: [connector('housing-mount', 'housing'), connector('shaft-mount', 'shaft', [10, 0, 0])],
        mates: [
            {
                id: 'mate-1',
                type: 'fixed',
                instanceA: 'housing',
                connectorA: 'housing-mount',
                instanceB: 'shaft',
                connectorB: 'shaft-mount'
            }
        ],
        groundedInstanceId: 'housing'
    };
}

function issuePaths(doc: AssemblyDocument): string[] {
    return validateAssemblyDocument(doc).issues.map((issue) => issue.path);
}

describe('validateAssemblyDocument', () => {
    it('accepts a minimal valid document', () => {
        expect(validateAssemblyDocument(validDocument())).toEqual({ valid: true, issues: [] });
    });

    it('accepts matrix placements and vector scales', () => {
        const doc = validDocument();
        doc.instances[1] = {
            id: 'shaft',
            part: 'embedded-shaft',
            placement: { matrix: [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
            scale: [1, 1, 2]
        };
        expect(validateAssemblyDocument(doc).valid).toBe(true);
    });

    it('rejects a missing groundedInstanceId (no implicit first-instance default)', () => {
        const doc = validDocument();
        doc.groundedInstanceId = '';
        const result = validateAssemblyDocument(doc);
        expect(result.valid).toBe(false);
        expect(issuePaths(doc)).toContain('groundedInstanceId');
    });

    it('rejects a groundedInstanceId that names no instance', () => {
        const doc = validDocument();
        doc.groundedInstanceId = 'ghost';
        const result = validateAssemblyDocument(doc);
        expect(result.valid).toBe(false);
        expect(issuePaths(doc)).toContain('groundedInstanceId');
    });

    it('rejects a wrong schema version', () => {
        const doc = validDocument();
        (doc as unknown as { version: number }).version = 2;
        expect(validateAssemblyDocument(doc).valid).toBe(false);
        expect(issuePaths(doc)).toContain('version');
    });

    it('rejects duplicate instance ids', () => {
        const doc = validDocument();
        doc.instances.push(instance('housing'));
        expect(issuePaths(doc)).toContain('instances[2].id');
    });

    it('rejects connectors on unknown instances', () => {
        const doc = validDocument();
        doc.connectors.push(connector('stray', 'ghost'));
        expect(issuePaths(doc)).toContain('connectors[2].instanceId');
    });

    it('rejects mates referencing unknown connectors', () => {
        const doc = validDocument();
        doc.mates[0].connectorB = 'ghost-connector';
        expect(issuePaths(doc)).toContain('mates[0].connectorB');
    });

    it('rejects mates referencing unknown instances', () => {
        const doc = validDocument();
        doc.mates[0].instanceB = 'ghost';
        const paths = issuePaths(doc);
        expect(paths).toContain('mates[0].instanceB');
        // The connector no longer belongs to the named instance either.
        expect(paths).toContain('mates[0].connectorB');
    });

    it('rejects a connector/instance ownership mismatch', () => {
        const doc = validDocument();
        doc.mates[0].connectorA = 'shaft-mount';
        expect(issuePaths(doc)).toContain('mates[0].connectorA');
    });

    it('rejects degenerate connector axes', () => {
        for (const axes of [
            { xAxis: [0, 0, 0] as Vec3, yAxis: [0, 1, 0] as Vec3 },
            { xAxis: [1, 0, 0] as Vec3, yAxis: [0, 0, 0] as Vec3 },
            { xAxis: [1, 0, 0] as Vec3, yAxis: [2, 0, 0] as Vec3 }
        ]) {
            const doc = validDocument();
            doc.connectors[0] = { ...connector('housing-mount', 'housing'), ...axes };
            expect(issuePaths(doc)).toContain('connectors[0].axes');
        }
    });

    it('rejects unknown mate types', () => {
        const doc = validDocument();
        (doc.mates[0] as unknown as { type: string }).type = 'gear';
        // Gear/screw coupling is a documented follow-up, not a mate type today.
        expect(issuePaths(doc)).toContain('mates[0].type');
    });

    it('rejects a second mate on the same part pair', () => {
        const doc = validDocument();
        doc.connectors.push(connector('housing-aux', 'housing'), connector('shaft-aux', 'shaft'));
        doc.mates.push({
            id: 'mate-2',
            type: 'revolute',
            instanceA: 'shaft',
            connectorA: 'shaft-aux',
            instanceB: 'housing',
            connectorB: 'housing-aux'
        });
        expect(issuePaths(doc)).toContain('mates[1]');
    });

    it('rejects self-mating an instance', () => {
        const doc = validDocument();
        doc.mates[0].instanceB = 'housing';
        doc.mates[0].connectorB = 'housing-mount';
        expect(issuePaths(doc)).toContain('mates[0]');
    });

    it('rejects malformed placements and scales', () => {
        const doc = validDocument();
        (doc.instances[1] as unknown as { placement: unknown }).placement = { position: [0, 0], orientation: [0, 0, 0, 1] };
        doc.instances[1].scale = -2;
        const paths = issuePaths(doc);
        expect(paths).toContain('instances[1].placement.position');
        expect(paths).toContain('instances[1].scale');
    });

    it('rejects a zero-length orientation quaternion', () => {
        const doc = validDocument();
        doc.instances[1].placement = { position: [0, 0, 0], orientation: [0, 0, 0, 0] };
        expect(issuePaths(doc)).toContain('instances[1].placement.orientation');
    });
});

describe('orthonormalizeConnectorAxes', () => {
    it('completes z as x cross y on orthonormal input', () => {
        expect(orthonormalizeConnectorAxes({ xAxis: [1, 0, 0], yAxis: [0, 1, 0] })).toEqual({
            xAxis: [1, 0, 0],
            yAxis: [0, 1, 0],
            zAxis: [0, 0, 1]
        });
    });

    it('normalizes and orthogonalizes near-orthonormal input', () => {
        const { xAxis, yAxis, zAxis } = orthonormalizeConnectorAxes({ xAxis: [2, 0, 0], yAxis: [0.001, 3, 0] });
        expect(xAxis[0]).toBeCloseTo(1, 12);
        expect(yAxis[1]).toBeCloseTo(1, 6);
        expect(zAxis[2]).toBeCloseTo(1, 6);
    });

    it('throws on zero-length or parallel axes', () => {
        expect(() => orthonormalizeConnectorAxes({ xAxis: [0, 0, 0], yAxis: [0, 1, 0] })).toThrow(/xAxis/);
        expect(() => orthonormalizeConnectorAxes({ xAxis: [1, 0, 0], yAxis: [-3, 0, 0] })).toThrow(/parallel/);
    });
});

describe('placement math', () => {
    it('creates an empty document with explicit grounding', () => {
        expect(createAssemblyDocument('frame', 'base')).toMatchObject({ version: 1, groundedInstanceId: 'base' });
    });

    it('converts pos+quat placements to matrices and passes matrices through', () => {
        expect(instancePlacementToMatrix({ position: [1, 2, 3], orientation: [0, 0, 0, 1] })).toEqual([
            1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1
        ]);
        const matrix = [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1] as const;
        expect(instancePlacementToMatrix({ matrix: [...matrix] })).toEqual([...matrix]);
    });

    it('normalizes quaternions and rejects zero length', () => {
        expect(normalizeQuaternion([0, 0, 0, 2])).toEqual([0, 0, 0, 1]);
        expect(() => normalizeQuaternion([0, 0, 0, 0])).toThrow(/zero-length/);
    });
});
