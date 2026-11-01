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

import { ChatWelcomeMessageProvider } from '@theia/ai-chat-ui/lib/browser/chat-tree-view';
import * as React from '@theia/core/shared/react';
import { nls } from '@theia/core/lib/common/nls';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { codicon, CommonCommands, LocalizedMarkdown, MarkdownRenderer } from '@theia/core/lib/browser';
import { CommandRegistry, DisposableCollection, Emitter, Event, PreferenceScope } from '@theia/core';
import { AgentService, FrontendLanguageModelRegistry } from '@theia/ai-core/lib/common';
import { PreferenceService } from '@theia/core/lib/common';
import { DEFAULT_CHAT_AGENT_PREF, BYPASS_MODEL_REQUIREMENT_PREF } from '@theia/ai-chat/lib/common/ai-chat-preferences';
import { ChatAgentRecommendationService, ChatAgentService } from '@theia/ai-chat/lib/common';
import { OPEN_AI_CONFIG_VIEW } from '@theia/ai-ide/lib/browser/ai-configuration/ai-configuration-view-contribution';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { NUKE_CHAT_AGENT_ID } from '../agent/nuke-chat-agent';
import { WelcomeQuickActions } from './welcome-quick-actions';
import { NukeAiBot } from './nuke-ai-bot';
import { mergeRecommendedAgents, NUKE_RECOMMENDED_AGENTS } from './nuke-agent-recommendations';
import './nuke-chat-welcome.css';

@injectable()
export class NukeChatWelcomeMessageProvider implements ChatWelcomeMessageProvider {
    readonly priority = 101;

    @inject(MarkdownRenderer)
    protected readonly markdownRenderer: MarkdownRenderer;

    @inject(CommandRegistry)
    protected readonly commandRegistry: CommandRegistry;

    @inject(FrontendLanguageModelRegistry)
    protected languageModelRegistry: FrontendLanguageModelRegistry;

    @inject(PreferenceService)
    protected preferenceService: PreferenceService;

    @inject(ChatAgentRecommendationService)
    protected recommendationService: ChatAgentRecommendationService;

    @inject(ChatAgentService)
    protected chatAgentService: ChatAgentService;

    @inject(AgentService)
    protected agentService: AgentService;

    protected readonly toDispose = new DisposableCollection();
    protected _hasReadyModels = false;
    protected _modelRequirementBypassed = false;
    protected _defaultAgent = '';
    protected modelConfig: { hasModels: boolean; errorMessages: string[] } | undefined;

    protected readonly onStateChangedEmitter = new Emitter<void>();

    get onStateChanged(): Event<void> {
        return this.onStateChangedEmitter.event;
    }

    @postConstruct()
    protected init(): void {
        console.log('NukeChatWelcomeMessageProvider initialized with priority', this.priority);
        this.checkLanguageModelStatus();
        this.toDispose.push(
            this.languageModelRegistry.onChange(() => {
                this.checkLanguageModelStatus();
            })
        );
        this.toDispose.push(
            this.preferenceService.onPreferenceChanged((e) => {
                if (e.preferenceName === DEFAULT_CHAT_AGENT_PREF) {
                    const effectiveValue = this.preferenceService.get<string>(DEFAULT_CHAT_AGENT_PREF, '');
                    if (this._defaultAgent !== effectiveValue) {
                        this._defaultAgent = effectiveValue;
                        this.notifyStateChanged();
                    }
                } else if (e.preferenceName === BYPASS_MODEL_REQUIREMENT_PREF) {
                    const effectiveValue = this.preferenceService.get<boolean>(BYPASS_MODEL_REQUIREMENT_PREF, false);
                    if (this._modelRequirementBypassed !== effectiveValue) {
                        this._modelRequirementBypassed = effectiveValue;
                        this.notifyStateChanged();
                    }
                }
            })
        );
        this.toDispose.push(
            this.agentService.onDidChangeAgents(() => {
                this.notifyStateChanged();
            })
        );
        this.analyzeModelConfiguration().then((config) => {
            this.modelConfig = config;
            this.notifyStateChanged();
        });
        this.preferenceService.ready.then(() => {
            const defaultAgentValue = this.preferenceService.get(DEFAULT_CHAT_AGENT_PREF, '');
            const bypassValue = this.preferenceService.get(BYPASS_MODEL_REQUIREMENT_PREF, false);
            if (!defaultAgentValue && this.chatAgentService.getAgent(NUKE_CHAT_AGENT_ID)) {
                this._defaultAgent = NUKE_CHAT_AGENT_ID;
                void this.preferenceService.set(DEFAULT_CHAT_AGENT_PREF, NUKE_CHAT_AGENT_ID, PreferenceScope.User);
            } else {
                this._defaultAgent = defaultAgentValue;
            }
            this._modelRequirementBypassed = bypassValue;
            this.notifyStateChanged();
        });
    }

    protected async checkLanguageModelStatus(): Promise<void> {
        const models = await this.languageModelRegistry.getLanguageModels();
        this._hasReadyModels = models.some((model) => model.status.status === 'ready');
        this.modelConfig = await this.analyzeModelConfiguration();
        this.notifyStateChanged();
    }

    protected async analyzeModelConfiguration(): Promise<{ hasModels: boolean; errorMessages: string[] }> {
        const models = await this.languageModelRegistry.getLanguageModels();
        const hasModels = models.length > 0;
        const unavailableModels = models.filter((model) => model.status.status === 'unavailable');
        const errorMessages = unavailableModels.map((model) => model.status.message).filter((msg): msg is string => !!msg);
        const uniqueErrorMessages = [...new Set(errorMessages)];
        return { hasModels, errorMessages: uniqueErrorMessages };
    }

    protected notifyStateChanged(): void {
        this.onStateChangedEmitter.fire();
    }

    get hasReadyModels(): boolean {
        return this._hasReadyModels;
    }

    get modelRequirementBypassed(): boolean {
        return this._modelRequirementBypassed;
    }

    get defaultAgent(): string {
        return this._defaultAgent;
    }

    protected setModelRequirementBypassed(bypassed: boolean): void {
        this.preferenceService.set(BYPASS_MODEL_REQUIREMENT_PREF, bypassed, PreferenceScope.User);
    }

    protected setDefaultAgent(agentId: string): void {
        this.preferenceService.set(DEFAULT_CHAT_AGENT_PREF, agentId, PreferenceScope.User);
    }

    dispose(): void {
        this.toDispose.dispose();
        this.onStateChangedEmitter.dispose();
    }

    renderWelcomeMessage(): React.ReactNode {
        if (!this._hasReadyModels && !this._modelRequirementBypassed) {
            return this.renderModelConfigurationScreen();
        }
        if (!this._defaultAgent) {
            return this.renderAgentSelectionScreen();
        }
        return this.renderWelcomeScreen();
    }

    protected renderWelcomeScreen(): React.ReactNode {
        return (
            <div className={'theia-WelcomeMessage theia-WelcomeMessage-Main'} key="normal-welcome" data-provider="nuke">
                <div className="nuke-welcome-logo-frame">
                    <NukeAiBot className="nuke-ai-bot-welcome" />
                </div>
                <LocalizedMarkdown
                    localizationKey="theia/ai/ide/chatWelcomeMessage"
                    defaultMarkdown={`
## Ask the NukeAI

Use *@AgentName* to talk to a specialized agent, like *@{0}*, *@{1}*, or *@{2}*.

Attach context with *#{3}*, *#{4}*, *#{5}*, or the attach button.
`}
                    args={['NukeAI', 'Coder', 'Universal', 'file', '_f', 'selectedText']}
                    markdownRenderer={this.markdownRenderer}
                    className="theia-WelcomeMessage-Content"
                    markdownOptions={{ supportHtml: true }}
                />
                {this.renderGuideButton()}
                <WelcomeQuickActions
                    hasReadyModel={this._hasReadyModels}
                    modelSettingsCommandId={OPEN_AI_CONFIG_VIEW.id}
                    onRun={(commandId) => void this.runWelcomeCommand(commandId)}
                />
            </div>
        );
    }

    protected async runWelcomeCommand(commandId: string): Promise<void> {
        try {
            await this.commandRegistry.executeCommand(commandId);
        } catch (error) {
            console.error(`[NukeAI] Failed to execute the welcome command ${commandId}.`, error);
        }
    }

    /** Open the NukeAI getting-started guide inside the IDE docs widget. */
    protected openNukeAiGuide(): void {
        void this.commandRegistry.executeCommand('nuke.docs.open', '/nuke-ai/user/getting-started.md').catch((error) => {
            console.error('[NukeAI] Failed to open the NukeAI guide.', error);
        });
    }

    /** Secondary call to action shared by the welcome and setup screens. */
    protected renderGuideButton(): React.ReactNode {
        return (
            <div className="nuke-welcome-guide">
                <button type="button" className="theia-button secondary nuke-welcome-guide-button" onClick={() => this.openNukeAiGuide()}>
                    <span className={codicon('book')} aria-hidden="true"></span>
                    {nls.localize('nuke/ai/openGuide', 'Open the NukeAI guide')}
                </button>
            </div>
        );
    }

    protected renderModelConfigurationScreen(): React.ReactNode {
        const config = this.modelConfig ?? { hasModels: false, errorMessages: [] };
        const { hasModels, errorMessages } = config;

        if (!hasModels) {
            return (
                <div className={'theia-WelcomeMessage'} key="setup-state">
                    <div className="theia-WelcomeMessage-ErrorIcon">⚠️</div>
                    <LocalizedMarkdown
                        localizationKey="theia/ai/ide/noLanguageModelProviders"
                        defaultMarkdown={`
## No Language Model Providers Available

No language model provider packages are installed in this IDE.

This typically happens in custom IDE distributions where NukeAI language model packages have been omitted.

**To resolve this:**

- Install one or more language model provider packages (e.g., '@theia/ai-openai', '@theia/ai-anthropic', '@theia/ai-ollama')
- Or use agents that don't require Nuke Language Models (e.g., Claude Code)
                `}
                        markdownRenderer={this.markdownRenderer}
                        className="theia-WelcomeMessage-Content"
                    />
                    <div className="theia-WelcomeMessage-Actions">
                        <button className="theia-button main" onClick={() => this.setModelRequirementBypassed(true)}>
                            {nls.localize('theia/ai/ide/continueAnyway', 'Continue Anyway')}
                        </button>
                    </div>
                    <small className="theia-WelcomeMessage-Hint">
                        {nls.localize('theia/ai/ide/bypassHint', "Some agents like Claude Code don't require Nuke Language Models")}
                    </small>
                </div>
            );
        }

        return (
            <div className={'theia-WelcomeMessage theia-WelcomeMessage-Main nuke-welcome-configuration'} key="setup-state">
                <div className="nuke-welcome-logo-frame">
                    <NukeAiBot className="nuke-ai-bot-welcome" />
                </div>
                <LocalizedMarkdown
                    key="configure-provider-hasmodels"
                    localizationKey="theia/ai/ide/configureProvider"
                    defaultMarkdown={`
## Configure a Language Model

Set up an API key for [OpenAI]({0}), [Anthropic]({1}), or [GoogleAI]({2}) or configure another provider like Ollama in the settings.

Some agents (e.g. Claude Code) work without a provider.
`}
                    args={[
                        `command:${CommonCommands.OPEN_PREFERENCES.id}?ai-features.openAiOfficial.openAiApiKey`,
                        `command:${CommonCommands.OPEN_PREFERENCES.id}?ai-features.anthropic.AnthropicApiKey`,
                        `command:${CommonCommands.OPEN_PREFERENCES.id}?ai-features.google.apiKey`
                    ]}
                    markdownRenderer={this.markdownRenderer}
                    className="theia-WelcomeMessage-Content"
                    markdownOptions={{
                        supportHtml: true,
                        isTrusted: { enabledCommands: [CommonCommands.OPEN_PREFERENCES.id] }
                    }}
                />
                {this.renderGuideButton()}
                {errorMessages.length > 0 && (
                    <div className="theia-alert theia-warning-alert theia-WelcomeMessage-Alert">
                        <div className="theia-message-header">
                            <span className={codicon('warning')}></span>
                            <span>{nls.localize('theia/ai/ide/configurationState', 'Configuration issues')}</span>
                        </div>
                        <div className="theia-message-content">
                            <ul className="theia-WelcomeMessage-IssuesList">
                                {errorMessages.map((msg, idx) => (
                                    <li key={idx}>{msg}</li>
                                ))}
                            </ul>
                        </div>
                    </div>
                )}
                <div className="theia-WelcomeMessage-Actions">
                    <button
                        className="theia-button main"
                        onClick={() => this.commandRegistry.executeCommand(CommonCommands.OPEN_PREFERENCES.id, 'ai-features')}
                    >
                        {nls.localize('theia/ai/ide/openSettings', 'Open AI Settings')}
                    </button>
                    <button className="theia-button secondary" onClick={() => this.setModelRequirementBypassed(true)}>
                        {nls.localize('theia/ai/ide/continueAnyway', 'Continue Anyway')}
                    </button>
                </div>
                <WelcomeQuickActions
                    hasReadyModel={this._hasReadyModels}
                    modelSettingsCommandId={OPEN_AI_CONFIG_VIEW.id}
                    onRun={(commandId) => void this.runWelcomeCommand(commandId)}
                />
            </div>
        );
    }

    protected renderAgentSelectionScreen(): React.ReactNode {
        const recommendedAgents = mergeRecommendedAgents(
            NUKE_RECOMMENDED_AGENTS,
            this.recommendationService.getRecommendedAgents(),
            (id) => this.chatAgentService.getAgent(id) !== undefined
        );

        return (
            <div className={'theia-WelcomeMessage theia-WelcomeMessage-Main theia-WelcomeMessage-AgentSelection'} key="agent-selection">
                <div className="nuke-welcome-logo-frame">
                    <NukeAiBot className="nuke-ai-bot-welcome" />
                </div>
                <LocalizedMarkdown
                    localizationKey="theia/ai/ide/selectDefaultAgent"
                    defaultMarkdown={`
## Select a Default Chat Agent

Choose the agent to use by default. You can always override this by mentioning *@AgentName* in your message.
`}
                    markdownRenderer={this.markdownRenderer}
                    className="theia-WelcomeMessage-Content"
                />
                {recommendedAgents.length > 0 ? (
                    <div className="theia-WelcomeMessage-AgentButtons">
                        {recommendedAgents.map((agent) => (
                            <Tooltip key={agent.id} content={agent.description ?? agent.label} position="top">
                                <button className="theia-WelcomeMessage-AgentButton" onClick={() => this.setDefaultAgent(agent.id)}>
                                    <span className={`theia-WelcomeMessage-AgentButton-Icon ${codicon('mention')}`}></span>
                                    <span className="theia-WelcomeMessage-AgentButton-Label">{agent.label}</span>
                                </button>
                            </Tooltip>
                        ))}
                    </div>
                ) : (
                    <p className="theia-WelcomeMessage-SubNote">
                        {nls.localize('theia/ai/ide/noRecommendedAgents', 'No recommended agents are available.')}
                    </p>
                )}
                <div className="theia-alert theia-info-alert theia-WelcomeMessage-Alert">
                    <div className="theia-message-header">
                        <span className={codicon('info')}></span>
                        <span>
                            {recommendedAgents.length > 0
                                ? nls.localize('theia/ai/ide/moreAgentsAvailable/header', 'More agents are available')
                                : nls.localize('theia/ai/ide/configureAgent/header', 'Configure a default agent')}
                        </span>
                    </div>
                    <div className="theia-message-content">
                        <LocalizedMarkdown
                            localizationKey="theia/ai/ide/moreAgentsAvailable"
                            defaultMarkdown="Use @AgentName to try others or configure a different default in [preferences]({0})."
                            args={[`command:${CommonCommands.OPEN_PREFERENCES.id}?ai-features.chat.defaultChatAgent`]}
                            markdownRenderer={this.markdownRenderer}
                            markdownOptions={{ isTrusted: { enabledCommands: [CommonCommands.OPEN_PREFERENCES.id] } }}
                        />
                    </div>
                </div>
            </div>
        );
    }

    renderDisabledMessage(): React.ReactNode {
        const openAiHistory = 'aiHistory:open';

        return (
            <div className={'theia-WelcomeMessage theia-WelcomeMessage-Main theia-WelcomeMessage-Disabled'} key="disabled-message">
                <div className="nuke-welcome-logo-frame">
                    <NukeAiBot className="nuke-ai-bot-welcome" />
                </div>
                <div className="theia-WelcomeMessage-Content">
                    <h2>{nls.localize('theia/ai/ide/chatDisabledMessage/title', 'AI Features are Disabled')}</h2>
                </div>
                <div className="theia-alert theia-info-alert theia-WelcomeMessage-Alert">
                    <div className="theia-message-header">
                        <span className={codicon('lightbulb')}></span>
                        <span>{nls.localize('theia/ai/ide/howToGetStarted', 'How to get started')}</span>
                    </div>
                    <div className="theia-message-content">
                        <LocalizedMarkdown
                            localizationKey="theia/ai/ide/chatDisabledMessage/steps"
                            defaultMarkdown={`1. Enable AI features in the settings
2. Configure at least one LLM provider (e.g. OpenAI, Anthropic, GoogleAI or Ollama)
3. Start chatting with powerful AI agents`}
                            markdownRenderer={this.markdownRenderer}
                        />
                    </div>
                </div>
                <div className="theia-WelcomeMessage-Actions">
                    <button
                        className="theia-button main"
                        onClick={() => this.commandRegistry.executeCommand(CommonCommands.OPEN_PREFERENCES.id, 'ai-features')}
                    >
                        {nls.localize('theia/ai/ide/openSettings', 'Open AI Settings')}
                    </button>
                </div>
                <LocalizedMarkdown
                    localizationKey="theia/ai/ide/chatDisabledMessage/features"
                    defaultMarkdown={`This will activate the AI features in the app. Please remember, these features are **in a beta state**,
so they may change and we are working on improving them.

Please support us by [providing feedback](https://github.com/eclipse-theia/theia)!

Once the AI features are enabled, you can access the following views and features:
- Code Completion
- Terminal Assistance (via CTRL+I in a terminal)
- This Chat View - available agents include:
  - Coder Chat Agent
  - Architect Chat Agent
  - Universal Chat Agent
- [AI History View]({0})
- [AI Configuration View]({1})

See [the documentation](https://theia-ide.org/docs/user_ai/) for more information.`}
                    args={[`command:${openAiHistory}`, `command:${OPEN_AI_CONFIG_VIEW.id}`]}
                    markdownRenderer={this.markdownRenderer}
                    className="theia-WelcomeMessage-Content"
                    markdownOptions={{
                        isTrusted: { enabledCommands: [openAiHistory, OPEN_AI_CONFIG_VIEW.id] }
                    }}
                />
            </div>
        );
    }
}
