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

import { describe, expect, it } from 'vitest';
import { NukeCadCommands } from '../../commands';
import { featureTreeCommand, featureTreeIcon } from './feature-tree-model';

describe('feature tree row mappings', () => {
    it('maps a native coil sweep to the coil icon and its add-feature command', () => {
        expect(featureTreeIcon('coilSweep')).toBe('codicon-nuke-cad-helix');
        expect(featureTreeCommand('coilSweep')).toBe(NukeCadCommands.ADD_FEATURE_COIL_SWEEP);
        expect(featureTreeCommand('coilSweep')?.id).toBe('nuke.cad.addFeature.coilSweep');
        expect(featureTreeCommand('coilSweep')?.label).toBe('Add Coil Sweep Feature');
    });

    it('keeps the existing sweep mappings unchanged', () => {
        expect(featureTreeIcon('sweep')).toBe('codicon-nuke-cad-sweep');
        expect(featureTreeCommand('sweep')).toBe(NukeCadCommands.ADD_FEATURE_SWEEP);
        expect(featureTreeCommand('import')).toBeUndefined();
        expect(featureTreeIcon('import')).toBe('codicon-file-symlink-file');
        expect(featureTreeIcon('unknownType')).toBe('codicon-symbol-method');
    });
});
