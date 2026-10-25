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
import { validateNukeCadDocument } from './cad-document';
import { SAMPLE_PROJECTS, createSampleDocument, getSampleProject } from './sample-projects';

describe('example projects', () => {
    it('keeps generated sample JSON in sync with the canonical e2e fixtures', () => {
        for (const [fixtureName, sampleName] of [
            ['gui_pincell.nuke-cad', 'gui_pincell.json'],
            ['tokamak_with_divertor.nuke-cad', 'tokamak_with_divertor.json']
        ]) {
            const fixture = path.resolve(__dirname, '..', '..', 'tests', 'e2e', 'assets', fixtureName);
            const sample = path.resolve(__dirname, 'samples', sampleName);
            expect(fs.readFileSync(sample, 'utf8'), `${sampleName} is stale; run yarn build`).toBe(fs.readFileSync(fixture, 'utf8'));
        }
    });

    it('ships unique, described samples', () => {
        expect(SAMPLE_PROJECTS).toHaveLength(3);
        expect(new Set(SAMPLE_PROJECTS.map((sample) => sample.id)).size).toBe(SAMPLE_PROJECTS.length);
        for (const sample of SAMPLE_PROJECTS) {
            expect(sample.name.length).toBeGreaterThan(0);
            expect(sample.description.length).toBeGreaterThan(0);
        }
        expect(SAMPLE_PROJECTS.map((sample) => sample.badge)).toEqual(['Fast', 'Large model', 'External']);
    });

    it('validates every bundled sample against the current schema', () => {
        for (const sample of SAMPLE_PROJECTS) {
            if (sample.document === undefined) {
                continue;
            }
            const result = validateNukeCadDocument(sample.document);
            expect(result.valid, `${sample.id}: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`).toBe(true);
        }
    });

    it('ships the three-body pincell demo', () => {
        const document = getSampleProject('pincell-demo')!.document!;
        expect(document.bodies).toHaveLength(3);
        expect(document.features).toHaveLength(3);
        // Display-only: reveal and distinguish the fuel/clad cylinders.
        expect(document.bodies.find((body) => body.label === 'fuel')?.appearance?.color).toBe('#d62728');
        expect(document.bodies.find((body) => body.label === 'moderator')?.appearance?.opacity).toBeCloseTo(0.22);
    });

    it('ships the 23-body tokamak with a first-build warning', () => {
        const sample = getSampleProject('tokamak-divertor')!;
        expect(sample.badge).toBe('Large model');
        expect(sample.document!.bodies).toHaveLength(23);
        expect(sample.document!.displayTolerance).toBe(0.015);
        expect(sample.warning).toContain('first build');
    });

    it('trims the tokamak sample contacts without changing the warning-policy fixture', () => {
        const sample = getSampleProject('tokamak-divertor')!;
        const features = sample.document!.features;
        const trims = features.filter((feature) => feature.id.startsWith('sample-trim-'));
        expect(trims.map((feature) => feature.type)).toEqual(['booleanCut', 'booleanCut', 'booleanCut', 'booleanCut']);
        expect(trims.every((feature) => (feature.params as Record<string, unknown>).keepTools === true)).toBe(true);
        expect(new Set(features.map((feature) => feature.id)).size).toBe(features.length);
    });

    it('offers the full W7-X as an external STEP import, not a bundled sector', () => {
        const sample = getSampleProject('w7x-full')!;
        expect(sample.badge).toBe('External');
        expect(sample.external).toBe(true);
        expect(sample.document).toBeUndefined();
        expect(sample.name).toContain('Full W7-X');
        expect(sample.warning?.toLowerCase()).toContain('not bundled');
        expect(sample.displayTolerance).toBe(0.1);
        expect(sample.copySource).toBe(true);
        expect(sample.download?.license).toBe('MIT');
        expect(sample.download?.fileName).toBe('scaled_w7x_stellarator.step');
        expect(sample.download?.url).toContain('proximafusion/open_stellarator_models');
        expect(sample.download?.url).toContain('af86bcaee80301e02a099f9fcecaf5849b053231');
        expect(createSampleDocument('w7x-full', 'nope')).toBeUndefined();
    });

    it('returns undefined for an unknown sample id', () => {
        expect(getSampleProject('missing')).toBeUndefined();
        expect(createSampleDocument('missing', 'Nope')).toBeUndefined();
    });

    it('clones a sample with the supplied name without mutating the shared sample', () => {
        const clone = createSampleDocument('pincell-demo', 'My pincell');
        expect(clone?.name).toBe('My pincell');
        clone!.bodies[0].name = 'mutated';
        clone!.parameters.fuelRadius = 99;

        const shared = getSampleProject('pincell-demo')!.document!;
        expect(shared.name).toBe('pincell');
        expect(shared.bodies[0].name).not.toBe('mutated');
        expect(shared.parameters.fuelRadius).toBe(0.4);

        const second = createSampleDocument('pincell-demo', 'Second copy');
        expect(second?.name).toBe('Second copy');
        expect(second?.bodies[0].name).toBe('clad');
        expect(second?.parameters.fuelRadius).toBe(0.4);
    });
});
