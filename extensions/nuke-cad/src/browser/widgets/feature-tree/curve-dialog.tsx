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
 * Dialog for creating and editing 3D curves.
 *
 * Supports points (CSV paste or file load), parametric expressions, and Fourier
 * coefficient series. The dialog validates inputs, samples parametric/Fourier
 * sources against the current document parameters, and returns a complete
 * {@link CurveDef} to the caller.
 *
 * @module nuke-cad/browser/widgets
 */

import * as React from '@theia/core/shared/react';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { NukeDialog } from 'nuke-essentials/lib/theme/browser/components';
import { type NukeCadDocument, type CurveDef, type CurveSource } from '../../../common/cad-document';
import { parseExpression, sampleParametric, sampleFourier } from '../../../common/expression';
import { sampleParametricWithUnits } from '../../document/cad-document-store';

export interface CurveDialogProps {
    readonly document: NukeCadDocument;
    readonly curve?: CurveDef;
    readonly fileDialogService: FileDialogService;
    readonly fileService: FileService;
    readonly onClose: () => void;
    readonly onSubmit: (def: CurveDef) => void;
}

const DEFAULT_SAMPLES = 256;

export function CurveDialog(props: CurveDialogProps): React.ReactElement {
    const { curve } = props;
    const isEdit = curve !== undefined;
    const [kind, setKind] = React.useState<CurveSource['kind']>(curve?.source?.kind ?? 'points');
    const [name, setName] = React.useState(curve?.name ?? `Curve ${props.document.curves.length + 1}`);
    const [error, setError] = React.useState<string | undefined>();

    // Points source state.
    const [pointsText, setPointsText] = React.useState(
        curve?.source?.kind === 'points' ? curve.samples.map((p) => p.join(', ')).join('\n') : ''
    );

    // Parametric source state.
    const [xExpr, setXExpr] = React.useState(curve?.source?.kind === 'parametric' ? curve.source.x : 'cos(t)');
    const [yExpr, setYExpr] = React.useState(curve?.source?.kind === 'parametric' ? curve.source.y : 'sin(t)');
    const [zExpr, setZExpr] = React.useState(curve?.source?.kind === 'parametric' ? curve.source.z : '0');
    const [tStart, setTStart] = React.useState(curve?.source?.kind === 'parametric' ? String(curve.source.tStart) : '0');
    const [tEnd, setTEnd] = React.useState(curve?.source?.kind === 'parametric' ? String(curve.source.tEnd) : String(2 * Math.PI));
    const [paramSampleCount, setParamSampleCount] = React.useState(
        curve?.source?.kind === 'parametric' ? String(curve.source.sampleCount) : String(DEFAULT_SAMPLES)
    );

    // Fourier source state.
    const [nfp, setNfp] = React.useState(curve?.source?.kind === 'fourier' ? String(curve.source.nfp) : '1');
    const [order, setOrder] = React.useState(curve?.source?.kind === 'fourier' ? String(curve.source.order) : '1');
    const [cosX, setCosX] = React.useState(curve?.source?.kind === 'fourier' ? curve.source.cosX.join(', ') : '1, 0');
    const [sinX, setSinX] = React.useState(curve?.source?.kind === 'fourier' ? curve.source.sinX.join(', ') : '0, 0');
    const [cosY, setCosY] = React.useState(curve?.source?.kind === 'fourier' ? curve.source.cosY.join(', ') : '0, 0');
    const [sinY, setSinY] = React.useState(curve?.source?.kind === 'fourier' ? curve.source.sinY.join(', ') : '0, 0');
    const [cosZ, setCosZ] = React.useState(curve?.source?.kind === 'fourier' ? curve.source.cosZ.join(', ') : '0, 0');
    const [sinZ, setSinZ] = React.useState(curve?.source?.kind === 'fourier' ? curve.source.sinZ.join(', ') : '0, 0');
    const [fourierSampleCount, setFourierSampleCount] = React.useState(
        curve?.source?.kind === 'fourier' ? String(curve.source.sampleCount) : String(DEFAULT_SAMPLES)
    );

    const loadPointsFromFile = async (): Promise<void> => {
        const uri = await props.fileDialogService.showOpenDialog({
            title: 'Load curve points',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { 'CSV / Text': ['csv', 'txt'] }
        });
        if (uri === undefined) {
            return;
        }
        try {
            const content = await props.fileService.read(uri);
            setPointsText(content.value.toString());
            setError(undefined);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };

    const submit = (): void => {
        setError(undefined);
        const result = buildCurveDef(
            props.document,
            curve?.id ?? '',
            name,
            kind,
            pointsText,
            { x: xExpr, y: yExpr, z: zExpr, tStart, tEnd, sampleCount: paramSampleCount },
            { nfp, order, cosX, sinX, cosY, sinY, cosZ, sinZ, sampleCount: fourierSampleCount }
        );
        if (!result.ok) {
            setError(result.error);
            return;
        }
        props.onSubmit(result.def);
    };

    return (
        <NukeDialog
            title={isEdit ? `Edit ${curve.name}` : 'New Curve'}
            onClose={props.onClose}
            footer={
                <>
                    <button className="theia-button" onClick={submit}>
                        <span className="codicon codicon-check" /> {isEdit ? 'Save' : 'Create'}
                    </button>
                    <button className="theia-button secondary" onClick={props.onClose}>
                        <span className="codicon codicon-close" /> Cancel
                    </button>
                </>
            }
        >
            <div className="cad-curve-dialog">
                {error !== undefined && <div className="cad-curve-dialog-error">{error}</div>}
                <label className="cad-curve-dialog-row">
                    Name
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                </label>
                <label className="cad-curve-dialog-row">
                    Source kind
                    <select value={kind} onChange={(e) => setKind(e.target.value as CurveSource['kind'])}>
                        <option value="points">Points</option>
                        <option value="parametric">Parametric</option>
                        <option value="fourier">Fourier</option>
                    </select>
                </label>
                {kind === 'points' && (
                    <>
                        <label className="cad-curve-dialog-row stacked">
                            Points (x, y, z per line)
                            <textarea
                                className="cad-curve-dialog-textarea"
                                value={pointsText}
                                onChange={(e) => setPointsText(e.target.value)}
                                rows={8}
                            />
                        </label>
                        <button className="theia-button secondary cad-curve-dialog-load" onClick={() => void loadPointsFromFile()}>
                            <span className="codicon codicon-file" /> Load from file
                        </button>
                    </>
                )}
                {kind === 'parametric' && (
                    <>
                        <label className="cad-curve-dialog-row">
                            x(t)
                            <input type="text" value={xExpr} onChange={(e) => setXExpr(e.target.value)} />
                        </label>
                        <label className="cad-curve-dialog-row">
                            y(t)
                            <input type="text" value={yExpr} onChange={(e) => setYExpr(e.target.value)} />
                        </label>
                        <label className="cad-curve-dialog-row">
                            z(t)
                            <input type="text" value={zExpr} onChange={(e) => setZExpr(e.target.value)} />
                        </label>
                        <div className="cad-curve-dialog-row-group">
                            <label className="cad-curve-dialog-row">
                                t start
                                <input type="number" value={tStart} onChange={(e) => setTStart(e.target.value)} />
                            </label>
                            <label className="cad-curve-dialog-row">
                                t end
                                <input type="number" value={tEnd} onChange={(e) => setTEnd(e.target.value)} />
                            </label>
                            <label className="cad-curve-dialog-row">
                                Samples
                                <input type="number" value={paramSampleCount} onChange={(e) => setParamSampleCount(e.target.value)} />
                            </label>
                        </div>
                    </>
                )}
                {kind === 'fourier' && (
                    <>
                        <div className="cad-curve-dialog-row-group">
                            <label className="cad-curve-dialog-row">
                                nfp
                                <input type="number" value={nfp} onChange={(e) => setNfp(e.target.value)} />
                            </label>
                            <label className="cad-curve-dialog-row">
                                Order
                                <input type="number" value={order} onChange={(e) => setOrder(e.target.value)} />
                            </label>
                            <label className="cad-curve-dialog-row">
                                Samples
                                <input type="number" value={fourierSampleCount} onChange={(e) => setFourierSampleCount(e.target.value)} />
                            </label>
                        </div>
                        <label className="cad-curve-dialog-row">
                            cos X
                            <input type="text" value={cosX} onChange={(e) => setCosX(e.target.value)} />
                        </label>
                        <label className="cad-curve-dialog-row">
                            sin X
                            <input type="text" value={sinX} onChange={(e) => setSinX(e.target.value)} />
                        </label>
                        <label className="cad-curve-dialog-row">
                            cos Y
                            <input type="text" value={cosY} onChange={(e) => setCosY(e.target.value)} />
                        </label>
                        <label className="cad-curve-dialog-row">
                            sin Y
                            <input type="text" value={sinY} onChange={(e) => setSinY(e.target.value)} />
                        </label>
                        <label className="cad-curve-dialog-row">
                            cos Z
                            <input type="text" value={cosZ} onChange={(e) => setCosZ(e.target.value)} />
                        </label>
                        <label className="cad-curve-dialog-row">
                            sin Z
                            <input type="text" value={sinZ} onChange={(e) => setSinZ(e.target.value)} />
                        </label>
                    </>
                )}
            </div>
        </NukeDialog>
    );
}

interface ParametricInputs {
    readonly x: string;
    readonly y: string;
    readonly z: string;
    readonly tStart: string;
    readonly tEnd: string;
    readonly sampleCount: string;
}

interface FourierInputs {
    readonly nfp: string;
    readonly order: string;
    readonly cosX: string;
    readonly sinX: string;
    readonly cosY: string;
    readonly sinY: string;
    readonly cosZ: string;
    readonly sinZ: string;
    readonly sampleCount: string;
}

interface BuildSuccess {
    readonly ok: true;
    readonly def: CurveDef;
}

interface BuildFailure {
    readonly ok: false;
    readonly error: string;
}

type BuildResult = BuildSuccess | BuildFailure;

function buildCurveDef(
    document: NukeCadDocument,
    id: string,
    name: string,
    kind: CurveSource['kind'],
    pointsText: string,
    parametric: ParametricInputs,
    fourier: FourierInputs
): BuildResult {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
        return { ok: false, error: 'Curve name is required' };
    }

    if (kind === 'points') {
        const parse = parsePointsText(pointsText);
        if (!parse.ok) {
            return { ok: false, error: parse.error };
        }
        if (parse.points.length < 4) {
            return { ok: false, error: `At least 4 points are required, got ${parse.points.length}` };
        }
        return {
            ok: true,
            def: {
                id,
                name: trimmedName,
                source: { kind: 'points' },
                samples: parse.points as [number, number, number][]
            }
        };
    }

    if (kind === 'parametric') {
        const expressions = [
            { label: 'x(t)', value: parametric.x },
            { label: 'y(t)', value: parametric.y },
            { label: 'z(t)', value: parametric.z }
        ];
        for (const expr of expressions) {
            const parsed = parseExpression(expr.value);
            if (!parsed.ok) {
                return { ok: false, error: `${expr.label}: ${parsed.error}` };
            }
        }
        const tStartNum = Number(parametric.tStart);
        const tEndNum = Number(parametric.tEnd);
        if (!Number.isFinite(tStartNum) || !Number.isFinite(tEndNum)) {
            return { ok: false, error: 't start and t end must be finite numbers' };
        }
        if (tEndNum <= tStartNum) {
            return { ok: false, error: 't end must be greater than t start' };
        }
        const sampleCountNum = parseInteger(parametric.sampleCount);
        if (sampleCountNum === undefined || sampleCountNum < 8 || sampleCountNum > 4096) {
            return { ok: false, error: 'Sample count must be an integer in [8, 4096]' };
        }
        const source = {
            kind: 'parametric' as const,
            x: parametric.x,
            y: parametric.y,
            z: parametric.z,
            tStart: tStartNum,
            tEnd: tEndNum,
            sampleCount: sampleCountNum
        };
        try {
            // The preview resamples exactly like the store: unitless documents
            // keep the legacy sampler (unit syntax rejected), declared units
            // coerce per coordinate. Failures surface as dialog errors.
            const samples =
                document.units === undefined
                    ? sampleParametric(source, document.parameters)
                    : sampleParametricWithUnits(source, document.parameters, document.units);
            return {
                ok: true,
                def: {
                    id,
                    name: trimmedName,
                    source,
                    samples: samples as [number, number, number][]
                }
            };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }

    // Fourier.
    const nfpNum = parseInteger(fourier.nfp);
    if (nfpNum === undefined || nfpNum < 1) {
        return { ok: false, error: 'nfp must be a positive integer' };
    }
    const orderNum = parseInteger(fourier.order);
    if (orderNum === undefined || orderNum < 0) {
        return { ok: false, error: 'Order must be a non-negative integer' };
    }
    const sampleCountNum = parseInteger(fourier.sampleCount);
    if (sampleCountNum === undefined || sampleCountNum < 32 || sampleCountNum > 4096) {
        return { ok: false, error: 'Sample count must be an integer in [32, 4096]' };
    }
    const cosXArr = parseNumberArray(fourier.cosX, orderNum + 1, 'cos X');
    const sinXArr = parseNumberArray(fourier.sinX, orderNum + 1, 'sin X', true);
    const cosYArr = parseNumberArray(fourier.cosY, orderNum + 1, 'cos Y');
    const sinYArr = parseNumberArray(fourier.sinY, orderNum + 1, 'sin Y', true);
    const cosZArr = parseNumberArray(fourier.cosZ, orderNum + 1, 'cos Z');
    const sinZArr = parseNumberArray(fourier.sinZ, orderNum + 1, 'sin Z', true);
    if (!cosXArr.ok || !sinXArr.ok || !cosYArr.ok || !sinYArr.ok || !cosZArr.ok || !sinZArr.ok) {
        return {
            ok: false,
            error:
                [cosXArr, sinXArr, cosYArr, sinYArr, cosZArr, sinZArr].find((r): r is BuildFailure => !r.ok)?.error ??
                'Invalid coefficients'
        };
    }
    const source = {
        kind: 'fourier' as const,
        nfp: nfpNum,
        order: orderNum,
        cosX: cosXArr.values,
        sinX: sinXArr.values,
        cosY: cosYArr.values,
        sinY: sinYArr.values,
        cosZ: cosZArr.values,
        sinZ: sinZArr.values,
        sampleCount: sampleCountNum
    };
    const samples = sampleFourier(source);
    return {
        ok: true,
        def: {
            id,
            name: trimmedName,
            source,
            samples: samples as [number, number, number][]
        }
    };
}

function parseInteger(value: string): number | undefined {
    const num = Number(value);
    if (!Number.isInteger(num)) {
        return undefined;
    }
    return num;
}

interface ParsedPoints {
    readonly ok: true;
    readonly points: number[][];
}

interface ParsePointsFailure {
    readonly ok: false;
    readonly error: string;
}

type ParsePointsResult = ParsedPoints | ParsePointsFailure;

function parsePointsText(text: string): ParsePointsResult {
    const points: number[][] = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.length === 0) {
            continue;
        }
        const parts = line.split(/[,\s]+/).filter((p) => p.length > 0);
        if (parts.length !== 3) {
            return { ok: false, error: `Line ${i + 1}: expected three numbers, got ${parts.length}` };
        }
        const nums = parts.map(Number);
        if (nums.some((n) => !Number.isFinite(n))) {
            return { ok: false, error: `Line ${i + 1}: contains a non-numeric value` };
        }
        points.push(nums);
    }
    return { ok: true, points };
}

interface ParsedArray {
    readonly ok: true;
    readonly values: number[];
}

interface ParseArrayFailure {
    readonly ok: false;
    readonly error: string;
}

type ParseArrayResult = ParsedArray | ParseArrayFailure;

function parseNumberArray(text: string, expectedLength: number, label: string, allowShorter = false): ParseArrayResult {
    const parts = text.split(/[,\s]+/).filter((p) => p.length > 0);
    const values = parts.map(Number);
    if (values.some((n) => !Number.isFinite(n))) {
        return { ok: false, error: `${label}: contains a non-numeric value` };
    }
    if (values.length > expectedLength || (!allowShorter && values.length !== expectedLength)) {
        return { ok: false, error: `${label}: expected ${expectedLength} coefficients, got ${values.length}` };
    }
    // Shorter arrays pad with zeros — missing higher-order terms read as 0,
    // matching the schema and the sampler.
    while (values.length < expectedLength) {
        values.push(0);
    }
    return { ok: true, values };
}
