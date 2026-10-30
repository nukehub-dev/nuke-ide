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
//    and/or materials provided with the distribution.
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
// *****************************************************************************

import { injectable } from '@theia/core/shared/inversify';
import { WorkspaceFileService, WorkspaceFileType } from '@theia/workspace/lib/common/workspace-file-service';

/**
 * Workspace file type override.
 *
 * "Save Workspace As" and the open/save dialog filters default to the Nuke
 * workspace format (``*.nuke-workspace``). The Theia and VS Code workspace
 * formats stay registered so existing ``*.theia-workspace`` and
 * ``*.code-workspace`` files keep opening.
 *
 * Bound over the Theia default by `workspace-config-frontend-module`.
 */
@injectable()
export class NukeWorkspaceFileService extends WorkspaceFileService {
    override getWorkspaceFileTypes(): WorkspaceFileType[] {
        return [
            { name: 'Nuke', extension: 'nuke-workspace' },
            { name: 'Theia', extension: 'theia-workspace' },
            { name: 'Visual Studio Code', extension: 'code-workspace' }
        ];
    }
}
