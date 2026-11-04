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
import { GeometryBuildResult, RegionManifestData, SandboxedScriptBuildResult } from '../../common/nuke-cad-protocol';

export interface CadModel {
    readonly scriptPath: string;
    readonly result: GeometryBuildResult;
    readonly manifest?: RegionManifestData;
    /**
     * True when the model was built from an AI-authored script inside the
     * bubblewrap sandbox. Sandboxed models must never be rebuilt or exported
     * through the unsandboxed geometry path.
     */
    readonly sandboxed?: boolean;
}

/**
 * Adapt a sandboxed script build result to the viewport's geometry result.
 *
 * The sandbox returns display artifacts only (no DAGMC/FEM exports or region
 * manifest), so the model carries the sandbox flag and metadata explicitly.
 */
export function sandboxedGeometryResult(result: SandboxedScriptBuildResult): GeometryBuildResult {
    return {
        success: result.success,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.tessPath !== undefined ? { tessPath: result.tessPath } : {}),
        ...(result.stepPath !== undefined ? { stepPath: result.stepPath } : {}),
        ...(result.solidCount !== undefined ? { solidCount: result.solidCount } : {}),
        ...(result.faceCount !== undefined ? { faceCount: result.faceCount } : {}),
        ...(result.triangleCount !== undefined ? { triangleCount: result.triangleCount } : {}),
        ...(result.boundingBox !== undefined ? { boundingBox: result.boundingBox } : {}),
        ...(result.warnings !== undefined ? { warnings: [...result.warnings] } : {}),
        ...(result.sandbox !== undefined ? { sandbox: result.sandbox } : {}),
        ...(sandboxedRegionManifest(result) !== undefined ? { regionManifest: sandboxedRegionManifest(result) } : {}),
        sandboxed: true
    };
}

/** Region manifest when the sandbox backend reports one (it normally does not). */
export function sandboxedRegionManifest(result: SandboxedScriptBuildResult): RegionManifestData | undefined {
    return (result as SandboxedScriptBuildResult & { readonly regionManifest?: RegionManifestData }).regionManifest;
}

export interface CadSelection {
    /**
     * Primary (last-clicked) solid; drives the properties panel and
     * fit-to-selection. Undefined when the selection is empty.
     */
    readonly solidId?: number;
    /** Precise face of the primary solid from a viewport pick, if any. */
    readonly faceId?: number;
    /**
     * Additional highlighted solids (Ctrl/Cmd-click multi-select in the Model
     * Outline). Always includes ``solidId`` when present; ignored when absent.
     */
    readonly solidIds?: readonly number[];
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
    /** Solids hidden by the Model Outline hide/isolate actions (viewport state). */
    private _hiddenSolidIds: readonly number[] = [];

    private readonly onModelChangeEmitter = new Emitter<CadModel | undefined>();
    readonly onModelChange: Event<CadModel | undefined> = this.onModelChangeEmitter.event;

    private readonly onSelectionChangeEmitter = new Emitter<CadSelection>();
    readonly onSelectionChange: Event<CadSelection> = this.onSelectionChangeEmitter.event;

    private readonly onSolidSummariesChangeEmitter = new Emitter<readonly SolidSummary[]>();
    readonly onSolidSummariesChange: Event<readonly SolidSummary[]> = this.onSolidSummariesChangeEmitter.event;

    private readonly onHiddenSolidsChangeEmitter = new Emitter<readonly number[]>();
    readonly onHiddenSolidsChange: Event<readonly number[]> = this.onHiddenSolidsChangeEmitter.event;

    get model(): CadModel | undefined {
        return this._model;
    }

    get scriptPath(): string | undefined {
        return this._model?.scriptPath;
    }

    setModel(model: CadModel | undefined): void {
        this._model = model;
        // Solid indices are positional and can shuffle between builds; stale
        // hide state would silently mask the wrong geometry.
        this._hiddenSolidIds = [];
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

    get hiddenSolidIds(): readonly number[] {
        return this._hiddenSolidIds;
    }

    isSolidHidden(solidId: number): boolean {
        return this._hiddenSolidIds.includes(solidId);
    }

    /** Replace the hidden-solids set (viewport applies it on change). */
    setHiddenSolidIds(ids: readonly number[]): void {
        this._hiddenSolidIds = ids;
        this.onHiddenSolidsChangeEmitter.fire(ids);
    }
}
