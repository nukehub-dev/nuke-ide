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

/**
 * Pure feature-row mappings for the Feature Tree.
 *
 * Kept out of the widget so the icon and command wiring (including the
 * "add another feature of this type" row action) is testable without React or
 * Theia browser modules.
 *
 * @module nuke-cad/browser/widgets
 */

import type { Command } from '@theia/core/lib/common/command';
import type { FeatureDef } from '../../../common/cad-document';
import { NukeCadCommands } from '../../commands';

/** Codicon class for a feature row; unknown types keep the generic method icon. */
export function featureTreeIcon(type: string): string {
    switch (type) {
        case 'pad':
            return 'codicon-nuke-cad-pad';
        case 'pocket':
            return 'codicon-nuke-cad-pocket';
        case 'revolve':
            return 'codicon-nuke-cad-revolve';
        case 'groove':
            return 'codicon-nuke-cad-groove';
        case 'sweep':
            return 'codicon-nuke-cad-sweep';
        case 'pipe':
            return 'codicon-nuke-cad-pipe';
        case 'loft':
            return 'codicon-nuke-cad-loft';
        case 'helicalSweep':
            return 'codicon-nuke-cad-helix';
        case 'coilSweep':
            return 'codicon-nuke-cad-helix';
        case 'fillet':
            return 'codicon-nuke-cad-fillet';
        case 'chamfer':
            return 'codicon-nuke-cad-chamfer';
        case 'draft':
            return 'codicon-nuke-cad-draft';
        case 'shell':
            return 'codicon-nuke-cad-shell';
        case 'linearPattern':
            return 'codicon-nuke-cad-linear-pattern';
        case 'circularPattern':
            return 'codicon-nuke-cad-circular-pattern';
        case 'mirror':
            return 'codicon-nuke-cad-mirror';
        case 'hole':
            return 'codicon-nuke-cad-hole';
        case 'translate':
            return 'codicon-nuke-cad-move';
        case 'booleanFuse':
            return 'codicon-nuke-cad-boolean-fuse';
        case 'booleanCut':
            return 'codicon-nuke-cad-boolean-cut';
        case 'booleanCommon':
            return 'codicon-nuke-cad-boolean-common';
        case 'import':
            return 'codicon-file-symlink-file';
        default:
            return 'codicon-symbol-method';
    }
}

/** Command that opens the matching "Add Feature" dialog; undefined when none exists. */
export function featureTreeCommand(type: FeatureDef['type']): Command | undefined {
    switch (type) {
        case 'pad':
            return NukeCadCommands.ADD_FEATURE_PAD;
        case 'pocket':
            return NukeCadCommands.ADD_FEATURE_POCKET;
        case 'revolve':
            return NukeCadCommands.ADD_FEATURE_REVOLVE;
        case 'groove':
            return NukeCadCommands.ADD_FEATURE_GROOVE;
        case 'sweep':
            return NukeCadCommands.ADD_FEATURE_SWEEP;
        case 'pipe':
            return NukeCadCommands.ADD_FEATURE_PIPE;
        case 'loft':
            return NukeCadCommands.ADD_FEATURE_LOFT;
        case 'helicalSweep':
            return NukeCadCommands.ADD_FEATURE_HELICAL_SWEEP;
        case 'coilSweep':
            return NukeCadCommands.ADD_FEATURE_COIL_SWEEP;
        default:
            return undefined;
    }
}
