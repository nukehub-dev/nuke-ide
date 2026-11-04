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

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { validateNukeCadDocument, type NukeCadDocument } from '../../common/cad-document';
import {
    getComponentTemplate,
    instantiateComponentTemplate,
    resolveComponentTemplateParameters,
    type ComponentTemplate
} from '../../common/component-templates';

/**
 * GUI-independent fixture driver for creation-time count overrides.
 *
 * The default fixtures keep the shipped counts; these cases prove the template
 * `configure` hook rebuilds the pattern or hole array before the candidate
 * build. Fixtures are written only under `NUKE_CAD_WRITE_FIXTURE=1`; the test
 * otherwise compares the generated document with the committed fixture.
 */

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', 'tests', 'e2e', 'assets');

interface OverrideCase {
    readonly stem: string;
    readonly templateId: string;
    readonly parameters: Readonly<Record<string, number>>;
}

const CASES: readonly OverrideCase[] = [
    { stem: 'gui_l_bracket_3_holes', templateId: 'l-bracket', parameters: { holeCount: 3 } },
    { stem: 'gui_flange_8_bolts', templateId: 'flange', parameters: { boltCount: 8 } },
    { stem: 'gui_bolt_circle_plate_6_holes', templateId: 'bolt-circle-plate', parameters: { holeCount: 6 } },
    {
        stem: 'gui_assembly_grid_plate_4_cells',
        templateId: 'assembly-grid-plate',
        parameters: { width: 6, height: 6, cellPitch: 1.2, cellCount: 4, cellDiameter: 0.9 }
    }
];

function templateById(id: string): ComponentTemplate {
    const template = getComponentTemplate(id);
    if (template === undefined) {
        throw new Error(`Unknown component template '${id}'`);
    }
    return template;
}

function buildDocument(testCase: OverrideCase): NukeCadDocument {
    const template = templateById(testCase.templateId);
    const resolved = resolveComponentTemplateParameters(template, testCase.parameters);
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    const document = instantiateComponentTemplate(template, testCase.stem, { ...resolved.values, ...resolved.templateValues });
    // The fixture is a standalone document, so pin the resolved document
    // parameters that its regenerated sketch was built from.
    for (const [name, value] of Object.entries(resolved.values)) {
        document.parameters[name] = value;
    }
    return document;
}

function canonicalize(value: unknown): unknown {
    if (typeof value === 'number') {
        return Math.round(value * 1e10) / 1e10;
    }
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value !== null && typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return value;
}

function canonicalJson(document: NukeCadDocument): string {
    return JSON.stringify(canonicalize(document), null, 2);
}

describe('component template count overrides', () => {
    it('builds validated documents with the requested count topology', () => {
        for (const testCase of CASES) {
            const document = buildDocument(testCase);
            const validation = validateNukeCadDocument(document);
            expect(validation.valid, `${testCase.stem}: ${JSON.stringify(validation.issues)}`).toBe(true);
        }
    });

    it('produces deterministic fixtures that match the committed assets', () => {
        for (const testCase of CASES) {
            const document = buildDocument(testCase);
            const fixturePath = path.join(FIXTURE_DIR, `${testCase.stem}.nuke-cad`);
            if (process.env.NUKE_CAD_WRITE_FIXTURE === '1') {
                fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
                fs.writeFileSync(fixturePath, canonicalJson(document) + '\n', 'utf-8');
            }
            expect(fs.existsSync(fixturePath), fixturePath).toBe(true);
            const fixtureDocument = JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as NukeCadDocument;
            expect(canonicalJson(document), testCase.stem).toBe(canonicalJson(fixtureDocument));
        }
    });
});
