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

import { inject, injectable, named } from '@theia/core/shared/inversify';
import { ContributionProvider } from '@theia/core/lib/common/contribution-provider';
import { PreferenceConfiguration, PreferenceConfigurations } from '@theia/core/lib/common/preferences';

/**
 * Workspace-scope configuration folder override.
 *
 * Theia reads and writes workspace-level configuration (settings.json plus the
 * tasks/launch/snippets sections) from `<project>/.theia/` by default. NukeIDE
 * rebrands that folder to `<project>/.nuke-ide/` so a workspace carries only
 * NukeIDE-branded dot folders; `.vscode` stays as the secondary path so VS
 * Code-authored settings keep working.
 *
 * Bound over the Theia default by `workspace-config-frontend-module`.
 */
@injectable()
export class NukePreferenceConfigurations extends PreferenceConfigurations {
    constructor(
        @inject(ContributionProvider)
        @named(PreferenceConfiguration)
        provider: ContributionProvider<PreferenceConfiguration>
    ) {
        super(provider);
    }

    override getPaths(): string[] {
        return ['.nuke-ide', '.vscode'];
    }
}
