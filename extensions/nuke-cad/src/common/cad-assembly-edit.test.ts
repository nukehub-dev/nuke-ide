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

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { PosQuatPlacement } from './assembly-document';
import { NUKE_CAD_SCHEMA_VERSION, validateNukeCadDocument, type NukeCadDocument } from './cad-document';
import { CAD_ASSEMBLY_EDIT_LIMIT, prepareAssemblyEdit, type AssemblyChangeInput, type PreparedAssemblyEdit } from './cad-assembly-edit';

const IDENTITY: PosQuatPlacement = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };

function placement(x: number): PosQuatPlacement {
    return { position: [x, 0, 0], orientation: [0, 0, 0, 1] };
}

function makeDocument(): NukeCadDocument {
    return {
        version: NUKE_CAD_SCHEMA_VERSION,
        name: 'assembly edit test',
        units: 'mm',
        parameters: {},
        datums: [{ id: 'datum-xy', kind: 'XY', name: 'XY' }],
        bodies: [
            { id: 'body-base', name: 'base', label: 'base', material: 'steel' },
            { id: 'body-arm', name: 'arm', label: 'arm' }
        ],
        sketches: [],
        features: [],
        curves: [],
        assembly: {
            instances: [
                { id: 'base', part: 'body:body-base', placement: { ...IDENTITY } },
                { id: 'arm', part: 'body:body-arm', placement: placement(20) }
            ],
            connectors: [],
            mates: [],
            groundedInstanceId: 'base'
        }
    };
}

function documentWithTwoArms(): NukeCadDocument {
    const document = makeDocument();
    document.assembly!.instances.push({ id: 'arm-2', part: 'body:body-arm', placement: placement(30) });
    return document;
}

function matedDocument(): NukeCadDocument {
    const document = makeDocument();
    document.assembly!.connectors = [
        { id: 'c-base', instanceId: 'base', origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] },
        { id: 'c-arm', instanceId: 'arm', origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }
    ];
    document.assembly!.mates = [
        { id: 'm1', type: 'fixed', instanceA: 'base', connectorA: 'c-base', instanceB: 'arm', connectorB: 'c-arm' }
    ];
    return document;
}

function fileBackedDocument(): NukeCadDocument {
    const document = makeDocument();
    document.assembly!.instances.push({ id: 'tool', part: './tool.nuke-cad', placement: placement(40) });
    return document;
}

function expectAccepted(document: NukeCadDocument, actions: readonly AssemblyChangeInput[]): PreparedAssemblyEdit {
    const result = prepareAssemblyEdit(document, actions);
    if (!result.ok) {
        throw new Error(`Expected the assembly edit to succeed: ${result.message}`);
    }
    return result.result;
}

function expectRejected(document: NukeCadDocument, actions: readonly AssemblyChangeInput[], pattern: RegExp): void {
    const before = JSON.stringify(document);
    const result = prepareAssemblyEdit(document, actions);
    if (result.ok) {
        throw new Error('Expected the assembly edit to be rejected');
    }
    expect(result.message).toMatch(pattern);
    expect(JSON.stringify(document)).toBe(before);
}

function add(id: string | undefined, part: string, position = 40, scale?: number | [number, number, number]): AssemblyChangeInput {
    return { action: 'addInstance', id, part, placement: placement(position), ...(scale !== undefined ? { scale } : {}) };
}

describe('prepareAssemblyEdit', () => {
    it('adds an embedded-body instance with an add change, solved placement, and BOM delta', () => {
        const document = makeDocument();
        const result = expectAccepted(document, [add('arm-2', 'body:body-arm', 40)]);

        expect(result.afterSection.instances.map((instance) => instance.id)).toEqual(['base', 'arm', 'arm-2']);
        expect(result.addedInstanceIds).toEqual(['arm-2']);
        expect(result.removedInstanceIds).toEqual([]);
        expect(result.changes).toEqual([
            {
                path: 'assemblies.instances.arm-2',
                label: 'Assembly instance arm-2',
                kind: 'add',
                after: 'body:body-arm'
            }
        ]);
        expect(result.placements).toHaveLength(1);
        expect(result.placements[0].kind).toBe('add');
        expect(result.placements[0].before).toBeUndefined();
        expect(result.placements[0].after?.placement).toEqual(placement(40));
        expect(result.placements[0].after?.matrix[3]).toBe(40);
        expect(result.placements[0].after?.solidIds).toEqual([]);
        expect(result.bomDelta.rows).toEqual([
            { part: 'body:body-arm', before: 1, after: 2, delta: 1 },
            { part: 'body:body-base', before: 1, after: 1, delta: 0 }
        ]);
        expect(result.bomDelta.beforeTotal).toBe(2);
        expect(result.bomDelta.afterTotal).toBe(3);
        expect(result.requiresAcknowledgement).toBe(false);
        expect(JSON.stringify(document)).toBe(JSON.stringify(makeDocument()));
    });

    it('generates a unique id when omitted and preserves a positive scale', () => {
        const result = expectAccepted(makeDocument(), [add(undefined, 'body:body-arm', 40, [2, 3, 4])]);

        expect(result.addedInstanceIds).toEqual(['instance-3']);
        const instance = result.afterSection.instances.find((candidate) => candidate.id === 'instance-3');
        expect(instance?.scale).toEqual([2, 3, 4]);
    });

    it('allows duplicating an existing file-backed instance part', () => {
        const result = expectAccepted(fileBackedDocument(), [add('tool-2', './tool.nuke-cad', 60)]);

        expect(result.afterSection.instances.filter((instance) => instance.part === './tool.nuke-cad')).toHaveLength(2);
        expect(result.bomDelta.rows).toEqual([
            { part: './tool.nuke-cad', before: 1, after: 2, delta: 1 },
            { part: 'body:body-arm', before: 1, after: 1, delta: 0 },
            { part: 'body:body-base', before: 1, after: 1, delta: 0 }
        ]);
    });

    it('removes a labelled embedded-body instance and marks the last region for acknowledgement', () => {
        const result = expectAccepted(makeDocument(), [{ action: 'removeInstance', instanceId: 'arm' }]);

        expect(result.afterSection.instances.map((instance) => instance.id)).toEqual(['base']);
        expect(result.removedInstanceIds).toEqual(['arm']);
        expect(result.changes).toEqual([
            {
                path: 'assemblies.instances.arm',
                label: 'Assembly instance arm',
                kind: 'remove',
                before: 'body:body-arm',
                after: undefined
            }
        ]);
        expect(result.placements[0].before?.placement).toEqual(placement(20));
        expect(result.placements[0].before?.matrix[3]).toBe(20);
        expect(result.placements[0].after).toBeUndefined();
        expect(result.removedSelectorKeys).toEqual(['arm/arm']);
        expect(result.removedRegions).toEqual([{ selector: 'arm', group: 'arm', solidIds: [] }]);
        expect(result.requiresAcknowledgement).toBe(true);
        expect(result.warnings.some((warning) => warning.includes("last instance of labelled body 'arm'"))).toBe(true);
        expect(result.bomDelta.rows).toEqual([
            { part: 'body:body-arm', before: 1, after: 0, delta: -1 },
            { part: 'body:body-base', before: 1, after: 1, delta: 0 }
        ]);
    });

    it('keeps the region acknowledged-free when another instance still uses the label', () => {
        const result = expectAccepted(documentWithTwoArms(), [{ action: 'removeInstance', instanceId: 'arm' }]);

        expect(result.removedSelectorKeys).toEqual(['arm/arm']);
        expect(result.removedRegions).toEqual([]);
        expect(result.requiresAcknowledgement).toBe(false);
        expect(result.warnings.some((warning) => warning.includes('other instances remain'))).toBe(true);
    });

    it('warns but does not acknowledge an unlabelled embedded body removal', () => {
        const document = makeDocument();
        document.bodies[1] = { id: 'body-arm', name: 'arm' };
        const result = expectAccepted(document, [{ action: 'removeInstance', instanceId: 'arm' }]);

        expect(result.removedSelectorKeys).toEqual([]);
        expect(result.removedRegions).toEqual([]);
        expect(result.requiresAcknowledgement).toBe(false);
        expect(result.warnings.some((warning) => warning.includes('no region label'))).toBe(true);
    });

    it('updates placement with before/after snapshots and no BOM quantity change', () => {
        const result = expectAccepted(makeDocument(), [{ action: 'setPlacement', instanceId: 'arm', placement: placement(30) }]);

        expect(result.changes).toEqual([
            {
                path: 'assemblies.instances.arm',
                label: 'Assembly instance arm',
                kind: 'update',
                before: placement(20),
                after: placement(30)
            }
        ]);
        expect(result.placements[0].kind).toBe('place');
        expect(result.placements[0].before?.matrix[3]).toBe(20);
        expect(result.placements[0].after?.matrix[3]).toBe(30);
        expect(result.bomDelta.rows.every((row) => row.delta === 0)).toBe(true);
        expect(result.afterDocument.assembly?.groundedInstanceId).toBe('base');
    });

    it('allows moving the grounded instance while preserving grounding', () => {
        const result = expectAccepted(makeDocument(), [{ action: 'setPlacement', instanceId: 'base', placement: placement(5) }]);

        expect(result.afterSection.groundedInstanceId).toBe('base');
        expect(result.placements[0].after?.matrix[3]).toBe(5);
    });

    it('applies a mixed add/remove/place batch atomically', () => {
        const result = expectAccepted(makeDocument(), [
            add('arm-2', 'body:body-arm', 40),
            { action: 'removeInstance', instanceId: 'arm' },
            { action: 'setPlacement', instanceId: 'base', placement: placement(2) }
        ]);

        expect(result.afterSection.instances.map((instance) => instance.id)).toEqual(['base', 'arm-2']);
        expect(result.addedInstanceIds).toEqual(['arm-2']);
        expect(result.removedInstanceIds).toEqual(['arm']);
        expect(result.changes).toHaveLength(3);
        expect(result.requiresAcknowledgement).toBe(false);
        expect(result.afterSection.groundedInstanceId).toBe('base');
    });

    it('rejects a request without an existing grounded assembly', () => {
        const noAssembly = makeDocument();
        delete noAssembly.assembly;
        expectRejected(noAssembly, [add('arm-2', 'body:body-arm')], /no assembly section/);

        const ungrounded = makeDocument();
        ungrounded.assembly!.groundedInstanceId = '';
        expectRejected(ungrounded, [add('arm-2', 'body:body-arm')], /grounded instance/);

        const dangling = makeDocument();
        dangling.assembly!.groundedInstanceId = 'missing';
        expectRejected(dangling, [add('arm-2', 'body:body-arm')], /does not exist/);
    });

    it('enforces the action count and duplicate-target rules before mutation', () => {
        expectRejected(makeDocument(), [], /No assembly edit actions/);
        const tooMany: AssemblyChangeInput[] = Array.from({ length: CAD_ASSEMBLY_EDIT_LIMIT + 1 }, (_, index) =>
            add(`extra-${index}`, 'body:body-arm', index)
        );
        expectRejected(makeDocument(), tooMany, /at most 16/);
        expectRejected(
            makeDocument(),
            [
                { action: 'removeInstance', instanceId: 'arm' },
                { action: 'setPlacement', instanceId: 'arm', placement: placement(30) }
            ],
            /Duplicate assembly edit/
        );
        expectRejected(makeDocument(), [add('base', 'body:body-arm')], /already in use/);
        expectRejected(makeDocument(), [add('arm-2', 'body:body-arm'), add('arm-2', 'body:body-arm')], /Duplicate assembly edit/);
    });

    it('rejects unknown bodies, arbitrary parts, and invalid placement/scale values', () => {
        expectRejected(makeDocument(), [add('bad', 'body:missing')], /unknown body/);
        expectRejected(makeDocument(), [add('bad', './not-an-instance.nuke-cad')], /neither a body:<id> source/);
        expectRejected(
            makeDocument(),
            [{ action: 'addInstance', id: 'bad', part: 'body:body-arm', placement: { position: [0, 0, 0], orientation: [0, 0, 0, 0] } }],
            /non-zero quaternion/
        );
        expectRejected(
            makeDocument(),
            [
                {
                    action: 'addInstance',
                    id: 'bad',
                    part: 'body:body-arm',
                    placement: { position: [0, Number.NaN, 0], orientation: [0, 0, 0, 1] }
                }
            ],
            /finite position/
        );
        expectRejected(makeDocument(), [add('bad', 'body:body-arm', 10, 0)], /scale/);
        expectRejected(makeDocument(), [add('bad', 'body:body-arm', 10, [1, 0, 1])], /scale/);
        expectRejected(
            makeDocument(),
            [{ action: 'setPlacement', instanceId: 'arm', placement: { position: [0, 0, 0], orientation: [0, 0, 0, 0] } }],
            /non-zero quaternion/
        );
    });

    it('rejects grounded, file-backed, mated, and connector-bearing removals', () => {
        expectRejected(makeDocument(), [{ action: 'removeInstance', instanceId: 'base' }], /grounded/);
        expectRejected(fileBackedDocument(), [{ action: 'removeInstance', instanceId: 'tool' }], /file-backed/);

        const mated = matedDocument();
        expectRejected(mated, [{ action: 'removeInstance', instanceId: 'arm' }], /participates in a mate/);
        expectRejected(mated, [{ action: 'removeInstance', instanceId: 'base' }], /grounded/);

        const connected = makeDocument();
        connected.assembly!.connectors = [{ id: 'c-arm', instanceId: 'arm', origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] }];
        expectRejected(connected, [{ action: 'removeInstance', instanceId: 'arm' }], /has connectors/);
    });

    it('rejects moving an instance that participates in a mate', () => {
        expectRejected(
            matedDocument(),
            [{ action: 'setPlacement', instanceId: 'arm', placement: placement(30) }],
            /participates in a mate/
        );
    });
});

describe('assembly_two_instances fixture', () => {
    it('is a valid v3 document with a grounded two-instance assembly', () => {
        const fixturePath = path.resolve(__dirname, '..', '..', 'tests', 'e2e', 'assets', 'assembly_two_instances.nuke-cad');
        const document = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as NukeCadDocument;

        const validation = validateNukeCadDocument(document);
        expect(validation.valid, validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')).toBe(true);
        expect(document.assembly?.groundedInstanceId).toBe('base');
        expect(document.assembly?.instances.map((instance) => instance.id)).toEqual(['base', 'arm']);
        expect(document.assembly?.mates).toEqual([]);
    });

    it('plans the arm 20→30 move that the live apply/undo scenario uses', () => {
        const fixturePath = path.resolve(__dirname, '..', '..', 'tests', 'e2e', 'assets', 'assembly_two_instances.nuke-cad');
        const document = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as NukeCadDocument;
        const result = expectAccepted(document, [{ action: 'setPlacement', instanceId: 'arm', placement: placement(30) }]);

        expect(result.placements[0].before?.matrix[3]).toBe(20);
        expect(result.placements[0].after?.matrix[3]).toBe(30);
        expect(result.requiresAcknowledgement).toBe(false);
    });
});
