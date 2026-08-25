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
 * Frontend state manager for the active CAD model.
 *
 * Holds the current script path, the latest build result, and the selected
 * solid/face. UI components observe this state via React state or direct
 * injection.
 *
 * @module nuke-cad/browser/state
 */

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { GeometryBuildResult, RegionManifestData } from '../../common/nuke-cad-protocol';

export interface CadModel {
    readonly scriptPath: string;
    readonly result: GeometryBuildResult;
    readonly manifest?: RegionManifestData;
}

export interface CadSelection {
    readonly solidId?: number;
    readonly faceId?: number;
}

/**
 * Optional per-solid geometric properties attached by newer tessellation
 * payloads (older backends omit the key entirely). Values are in model units.
 */
export interface TessSolidProperties {
    readonly volume?: number;
    readonly area?: number;
    readonly bbox?: { readonly min: number[]; readonly max: number[] };
    readonly centerOfMass?: number[];
}

/** Lightweight per-solid summary extracted from the tessellation payload. */
export interface SolidSummary {
    readonly solidId: number;
    readonly bodyId?: string;
    readonly faceCount: number;
    readonly edgeCount: number;
    readonly triangleCount: number;
    readonly properties?: TessSolidProperties;
}

@injectable()
export class NukeCadStateManager {
    private _model?: CadModel;
    private _selection: CadSelection = {};
    private _solidSummaries: readonly SolidSummary[] = [];

    private readonly onModelChangeEmitter = new Emitter<CadModel | undefined>();
    readonly onModelChange: Event<CadModel | undefined> = this.onModelChangeEmitter.event;

    private readonly onSelectionChangeEmitter = new Emitter<CadSelection>();
    readonly onSelectionChange: Event<CadSelection> = this.onSelectionChangeEmitter.event;

    private readonly onSolidSummariesChangeEmitter = new Emitter<readonly SolidSummary[]>();
    readonly onSolidSummariesChange: Event<readonly SolidSummary[]> = this.onSolidSummariesChangeEmitter.event;

    get model(): CadModel | undefined {
        return this._model;
    }

    get scriptPath(): string | undefined {
        return this._model?.scriptPath;
    }

    setModel(model: CadModel | undefined): void {
        this._model = model;
        this.onModelChangeEmitter.fire(model);
    }

    get selection(): CadSelection {
        return this._selection;
    }

    setSelection(selection: CadSelection): void {
        this._selection = selection;
        this.onSelectionChangeEmitter.fire(selection);
    }

    get solidSummaries(): readonly SolidSummary[] {
        return this._solidSummaries;
    }

    /** Called by the viewport after each tessellation parse; [] clears stale data. */
    setSolidSummaries(summaries: readonly SolidSummary[]): void {
        this._solidSummaries = summaries;
        this.onSolidSummariesChangeEmitter.fire(summaries);
    }
}
