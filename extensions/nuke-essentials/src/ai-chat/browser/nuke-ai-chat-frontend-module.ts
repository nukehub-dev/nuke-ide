// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import { ContainerModule } from '@theia/core/shared/inversify';
import { ChatWelcomeMessageProvider } from '@theia/ai-chat-ui/lib/browser/chat-tree-view';
import { NukeChatWelcomeMessageProvider } from './nuke-chat-welcome-message-provider';
import { ChatSessionsWelcomeMessageProvider } from '@theia/ai-ide/lib/browser/chat-sessions-welcome-message-provider';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
    // Unbind any existing ChatWelcomeMessageProvider contributions
    // This ensures we replace the default IdeChatWelcomeMessageProvider
    const boundBefore = isBound(ChatWelcomeMessageProvider);
    if (boundBefore) {
        unbind(ChatWelcomeMessageProvider);
    }
    
    // Bind our custom provider with higher priority (101)
    bind(ChatWelcomeMessageProvider).to(NukeChatWelcomeMessageProvider).inSingletonScope();
    
    // Bind the sessions provider (original priority)
    bind(ChatWelcomeMessageProvider).to(ChatSessionsWelcomeMessageProvider).inSingletonScope();
});