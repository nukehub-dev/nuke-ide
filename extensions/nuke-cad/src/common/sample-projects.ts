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

/**
 * Ready-made example projects for the New Document picker.
 *
 * Unlike the blank-document parameter presets (`DocumentTemplate`), a sample is
 * a complete {@link NukeCadDocument} copied into a new editable document.
 * Sample metadata is never stored in the created document.
 *
 * @module nuke-cad/common
 */

import { type NukeCadDocument } from './cad-document';
import pincellJson from './samples/gui_pincell.json';
import tokamakJson from './samples/tokamak_with_divertor.json';

/** Public download metadata for an external sample source. */
export interface SampleDownload {
    /** Direct URL for the exchange file. */
    readonly url: string;
    /** File name written into the project parts folder. */
    readonly fileName: string;
    /** Human-readable download size. */
    readonly sizeLabel: string;
    /** Source license shown in the picker. */
    readonly license: string;
}

/** A sample document or an external-source import offered beside the presets. */
export interface SampleProject {
    /** Stable sample identifier. */
    readonly id: string;
    /** Short human-readable name. */
    readonly name: string;
    /** One-line description shown in the picker. */
    readonly description: string;
    /** Optional workload/availability hint rendered as a badge. */
    readonly badge?: 'Fast' | 'Large model' | 'External';
    /** Optional caution rendered under the description. */
    readonly warning?: string;
    /** Complete document cloned into a new editable document. Absent for external samples. */
    readonly document?: NukeCadDocument;
    /** True when selecting the sample should open the CAD import file picker. */
    readonly external?: boolean;
    /** Opt-in generator that builds a complete parametric project from the external source or committed metadata. */
    readonly generator?: 'w7x' | 'w7x-shape';
    /** Display tolerance applied when an external sample creates its document. */
    readonly displayTolerance?: number;
    /** Copy the chosen source into `<document>.parts/` for a self-contained project. */
    readonly copySource?: boolean;
    /** Optional public source the sample can download into the project folder. */
    readonly download?: SampleDownload;
}

/**
 * Display-only tweak for the pincell sample: the moderator box otherwise hides
 * the fuel/clad cylinders on first open. The e2e fixture stays byte-identical;
 * only this bundled sample copy carries the opacity override.
 */
function decoratePincell(document: NukeCadDocument): NukeCadDocument {
    const appearance: Record<string, { color: string; opacity: number }> = {
        fuel: { color: '#d62728', opacity: 1 },
        clad: { color: '#7f7f7f', opacity: 1 },
        moderator: { color: '#1f77b4', opacity: 0.22 }
    };
    for (const body of document.bodies) {
        const override = body.label !== undefined ? appearance[body.label] : undefined;
        if (override !== undefined) {
            body.appearance = override;
        }
    }
    return document;
}

/**
 * Trim the tokamak sample's known cross-body contacts without merging bodies.
 *
 * The e2e fixture intentionally reports five cross-body overlaps (nested
 * first-wall/blanket layers and two TF inner legs clipping the coil pattern).
 * For a first-run sample those warnings are noise, so this copy subtracts the
 * smaller overlapping body from its neighbour and keeps both tools. The e2e
 * fixture remains untouched and is still the warning-policy regression.
 */
function decorateTokamak(document: NukeCadDocument): NukeCadDocument {
    // The four trims keep every body, but their extra cut faces push the
    // default 0.01 display tessellation past the frontend's file-read budget.
    // A coarser display-only tolerance keeps the sample at ~105 MB / 1.27M
    // triangles while all 22 bodies remain and the five overlaps disappear.
    document.displayTolerance = 0.015;
    document.features.push(
        {
            id: 'sample-trim-inboard-blanket',
            name: 'trim inboard blanket overlap',
            type: 'booleanCut',
            body: 'body-18',
            params: { targetBody: 'body-18', toolBodies: ['body-19'], keepTools: true },
            dependsOn: ['inboard_blanket', 'first_wall_inboard'],
            suppressed: false
        },
        {
            id: 'sample-trim-outboard-wall',
            name: 'trim outboard first-wall overlap',
            type: 'booleanCut',
            body: 'body-20',
            params: { targetBody: 'body-20', toolBodies: ['body-19'], keepTools: true },
            dependsOn: ['first_wall_outboard', 'first_wall_inboard'],
            suppressed: false
        },
        {
            id: 'sample-trim-outboard-blanket',
            name: 'trim outboard blanket overlap',
            type: 'booleanCut',
            body: 'body-21',
            params: { targetBody: 'body-21', toolBodies: ['body-20'], keepTools: true },
            dependsOn: ['outboard_blanket', 'first_wall_outboard'],
            suppressed: false
        },
        {
            id: 'sample-trim-tf-inner-legs',
            name: 'trim TF inner-leg contacts',
            type: 'booleanCut',
            body: 'body-1',
            params: { targetBody: 'body-1', toolBodies: ['body-12', 'body-15'], keepTools: true },
            dependsOn: ['tf-coil-clip', 'inner-leg-2', 'inner-leg-5'],
            suppressed: false
        }
    );
    return document;
}

const PINCELL_DOCUMENT = decoratePincell(pincellJson as unknown as NukeCadDocument);
const TOKAMAK_DOCUMENT = decorateTokamak(tokamakJson as unknown as NukeCadDocument);

/**
 * Pinned public reference STEP shared by both external W7-X samples.
 *
 * The repository commit keeps the download reproducible; upstream model
 * changes cannot silently swap the validated inventory.
 */
const W7X_DOWNLOAD: SampleDownload = {
    url: 'https://raw.githubusercontent.com/proximafusion/open_stellarator_models/af86bcaee80301e02a099f9fcecaf5849b053231/scaled_w7x_stellarator.step',
    fileName: 'scaled_w7x_stellarator.step',
    sizeLabel: '47 MB',
    license: 'MIT'
};

/**
 * Built-in example projects offered with the CAD modeler.
 *
 * The full W7-X stellarator is a ~47 MB external STEP (Proxima Fusion); it is
 * not bundled. Its card routes through the one-click CAD import picker so the
 * full device can be loaded when the user has that file. The generator card
 * builds the validated five-module project from fifteen imported bodies and
 * fifty-five assembly instances instead of one frozen STEP instance.
 */
export const SAMPLE_PROJECTS: ReadonlyArray<SampleProject> = [
    {
        id: 'pincell-demo',
        name: 'Pincell demo',
        description: 'Three-body fuel/clad/moderator pincell with parametric sketch dimensions.',
        badge: 'Fast',
        document: PINCELL_DOCUMENT
    },
    {
        id: 'tokamak-divertor',
        name: 'Tokamak with divertor',
        description: 'Sector tokamak with PF/TF coils, blankets, first walls, plasma, and a lower divertor.',
        badge: 'Large model',
        warning: 'The first build can take a while: 23 bodies are revolved, patterned, and boolean-clipped.',
        document: TOKAMAK_DOCUMENT
    },
    {
        id: 'w7x-full',
        name: 'Full W7-X stellarator',
        description:
            'Download or choose the ~47 MB reactor-scaled Proxima Fusion W7-X STEP; it is stored in the project folder and imported as a full assembly.',
        badge: 'External',
        warning: 'MIT-licensed model; not bundled. NukeIDE stores it in a .parts folder beside the saved document.',
        external: true,
        // 55 solids at default display detail exceed the frontend read budget.
        displayTolerance: 0.1,
        // The reference STEP is too large to bundle; copy it into the saved
        // project folder so the resulting .nuke-cad is portable.
        copySource: true,
        download: W7X_DOWNLOAD
    },
    {
        id: 'w7x-generator',
        name: 'W7-X generator (parametric)',
        description:
            'Parametric W7-X project: 10 exact coil bodies placed across 5 modules plus 5 full-360 shell bodies, as 15 imported B-reps and 55 assembly instances.',
        badge: 'External',
        warning: 'Requires the ~47 MB STEP; validated 5-module layout only (50 coils)',
        external: true,
        generator: 'w7x',
        // The 55-instance assembly exceeds the default frontend display budget.
        displayTolerance: 0.1,
        // The source STEP stays beside the generated document for portability.
        copySource: true,
        download: W7X_DOWNLOAD
    },
    {
        id: 'w7x-coil-shape',
        name: 'W7-X coil shape study (native)',
        description: '10 editable native coil sweeps × 5 modules, no external STEP; adjust section, tilt, twist, and path.',
        badge: 'Fast',
        warning: 'Approximate native sweeps, not the reference B-rep; simulation export disabled.',
        generator: 'w7x-shape',
        displayTolerance: 0.1
    }
];

/** Look up a built-in sample project by id. */
export function getSampleProject(id: string): SampleProject | undefined {
    return SAMPLE_PROJECTS.find((sample) => sample.id === id);
}

/**
 * Clone a sample document with the supplied name.
 *
 * Returns undefined for an unknown id. The clone is independent of the shared
 * sample so edits never leak into the next document created from it.
 */
export function createSampleDocument(sampleId: string, name: string): NukeCadDocument | undefined {
    const sample = getSampleProject(sampleId);
    if (sample?.document === undefined) {
        return undefined;
    }
    const clone = JSON.parse(JSON.stringify(sample.document)) as NukeCadDocument;
    clone.name = name;
    return clone;
}
