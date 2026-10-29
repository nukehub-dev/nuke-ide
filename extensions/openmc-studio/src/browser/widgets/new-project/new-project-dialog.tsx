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
 * New-project template picker.
 *
 * Cards are keyboard-selectable, "Blank Project" is selected by default, and
 * the preview summarises the model before it is created. The dialog renders
 * inside the dashboard widget so its narrow-panel container queries follow the
 * editor width rather than the browser viewport.
 *
 * @module openmc-studio/browser/widgets/new-project
 */

import * as React from '@theia/core/shared/react';
import { Tooltip } from 'nuke-essentials/lib/theme/browser/components';
import { OpenMCProjectTemplate, OpenMCProjectTemplateParameter, OpenMCProjectTemplateType } from '../../../common/openmc-state-schema';
import { PROJECT_TEMPLATE_DEFINITIONS, previewProjectTemplate, ProjectTemplateParameters } from '../../../common/project-templates';

/** Values collected by the New Project dialog. */
export interface NewProjectRequest {
    /** Selected template id. */
    templateId: OpenMCProjectTemplateType;
    /** Project name typed by the user. */
    name: string;
    /** Numeric template parameters. */
    parameters: Record<string, number>;
}

/** Props for {@link NewProjectDialog}. */
export interface NewProjectDialogProps {
    /** Close without creating anything. */
    onCancel(): void;
    /** Create the selected template. */
    onCreate(request: NewProjectRequest): void;
}

/** Default parameters for a template. */
function defaultParameters(template: OpenMCProjectTemplate): Record<string, number> {
    const values: Record<string, number> = {};
    for (const parameter of template.parameters ?? []) {
        values[parameter.key] = parameter.default;
    }
    return values;
}

/** Human-readable default project name for a template. */
function defaultProjectName(template: OpenMCProjectTemplate): string {
    return template.id === 'blank' ? 'Untitled Project' : template.name;
}

/** Render one numeric parameter field. */
function ParameterField(props: {
    parameter: OpenMCProjectTemplateParameter;
    value: number;
    onChange(value: number): void;
}): React.ReactElement {
    const { parameter, value, onChange } = props;
    const id = `new-project-parameter-${parameter.key}`;
    return (
        <div className="new-project-parameter">
            <label htmlFor={id}>{parameter.label}</label>
            <div className="new-project-parameter-input">
                <input
                    id={id}
                    type="number"
                    value={Number.isFinite(value) ? value : parameter.default}
                    min={parameter.min}
                    max={parameter.max}
                    step={parameter.step ?? 1}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next)) {
                            onChange(next);
                        }
                    }}
                />
                {parameter.unit && <span className="new-project-parameter-unit">{parameter.unit}</span>}
            </div>
        </div>
    );
}

/**
 * Template picker dialog. Renders a radio-style card group, parameter fields
 * for the selected template, and a live preview summary.
 */
export function NewProjectDialog(props: NewProjectDialogProps): React.ReactElement {
    const { onCancel, onCreate } = props;
    const [selectedId, setSelectedId] = React.useState<OpenMCProjectTemplateType>('blank');
    const [name, setName] = React.useState('Untitled Project');
    const [parameters, setParameters] = React.useState<Record<string, number>>({});
    const dialogRef = React.useRef<HTMLDivElement>(null);
    const cardRefs = React.useRef<Array<HTMLDivElement | null>>([]);

    const selected = PROJECT_TEMPLATE_DEFINITIONS.find((template) => template.id === selectedId) ?? PROJECT_TEMPLATE_DEFINITIONS[0];

    React.useEffect(() => {
        // Focus the selected card so keyboard users land in the picker.
        const index = PROJECT_TEMPLATE_DEFINITIONS.findIndex((template) => template.id === selected.id);
        window.setTimeout(() => cardRefs.current[index]?.focus(), 0);
    }, [selected.id]);

    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onCancel]);

    const selectTemplate = (template: OpenMCProjectTemplate): void => {
        setSelectedId(template.id);
        setName(defaultProjectName(template));
        setParameters(defaultParameters(template));
    };

    const moveSelection = (delta: number): void => {
        const index = PROJECT_TEMPLATE_DEFINITIONS.findIndex((template) => template.id === selectedId);
        const nextIndex = (index + delta + PROJECT_TEMPLATE_DEFINITIONS.length) % PROJECT_TEMPLATE_DEFINITIONS.length;
        const next = PROJECT_TEMPLATE_DEFINITIONS[nextIndex];
        selectTemplate(next);
        window.setTimeout(() => cardRefs.current[nextIndex]?.focus(), 0);
    };

    const preview = previewProjectTemplate(selected.id, parameters as ProjectTemplateParameters);
    const canCreate = name.trim().length > 0;

    const create = (): void => {
        if (!canCreate) {
            return;
        }
        onCreate({ templateId: selected.id, name: name.trim(), parameters });
    };

    return (
        <div
            className="new-project-overlay"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onCancel();
                }
            }}
        >
            <div className="new-project-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="new-project-title">
                <div className="new-project-header">
                    <div>
                        <h2 id="new-project-title">New Project</h2>
                        <p>Start from a runnable template or a blank model. You can change everything afterwards.</p>
                    </div>
                    <Tooltip content="Close" position="left">
                        <button className="theia-button secondary icon-only" onClick={onCancel} aria-label="Close">
                            <i className="codicon codicon-close"></i>
                        </button>
                    </Tooltip>
                </div>

                <div className="new-project-name">
                    <label htmlFor="new-project-name">Project name</label>
                    <input
                        id="new-project-name"
                        type="text"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Project name"
                    />
                </div>

                <div className="new-project-cards" role="radiogroup" aria-label="Project templates">
                    {PROJECT_TEMPLATE_DEFINITIONS.map((template, index) => {
                        const isSelected = template.id === selectedId;
                        return (
                            <div
                                key={template.id}
                                ref={(element) => {
                                    cardRefs.current[index] = element;
                                }}
                                className={`new-project-card ${isSelected ? 'selected' : ''}`}
                                role="radio"
                                aria-checked={isSelected}
                                aria-label={`${template.name}. ${template.description}`}
                                tabIndex={isSelected ? 0 : -1}
                                onClick={() => selectTemplate(template)}
                                onKeyDown={(event) => {
                                    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                                        event.preventDefault();
                                        moveSelection(1);
                                    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                                        event.preventDefault();
                                        moveSelection(-1);
                                    } else if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        selectTemplate(template);
                                    }
                                }}
                            >
                                <div className="new-project-card-head">
                                    <i className={template.icon} aria-hidden="true"></i>
                                    <span className="new-project-card-name">{template.name}</span>
                                    {template.demonstration && <span className="new-project-card-badge">Demonstration</span>}
                                </div>
                                <p className="new-project-card-description">{template.description}</p>
                                <ul className="new-project-card-list">
                                    {(template.whatYouGet ?? []).map((item) => (
                                        <li key={item}>{item}</li>
                                    ))}
                                </ul>
                                <div className="new-project-card-preview">{preview}</div>
                            </div>
                        );
                    })}
                </div>

                <div className="new-project-details">
                    <div className="new-project-parameters">
                        <h3>Parameters</h3>
                        {selected.parameters && selected.parameters.length > 0 ? (
                            <div className="new-project-parameter-grid">
                                {selected.parameters.map((parameter) => (
                                    <ParameterField
                                        key={`${selected.id}-${parameter.key}`}
                                        parameter={parameter}
                                        value={parameters[parameter.key] ?? parameter.default}
                                        onChange={(value) =>
                                            setParameters((current) => ({
                                                ...current,
                                                [parameter.key]: value
                                            }))
                                        }
                                    />
                                ))}
                            </div>
                        ) : (
                            <p className="new-project-no-parameters">
                                This template has no parameters; it creates an empty model with default settings.
                            </p>
                        )}
                        <div className="new-project-preview-summary">
                            <span className="new-project-preview-label">Preview</span>
                            <span>{preview}</span>
                        </div>
                        {selected.requires && <p className="new-project-requirement">{selected.requires}</p>}
                    </div>
                </div>

                <p className="new-project-footnote">
                    Runs need an OpenMC environment and a cross-section library. The Simulation tab readiness checklist reports anything
                    missing.
                </p>

                <div className="new-project-footer">
                    <button className="theia-button secondary" onClick={onCancel}>
                        Cancel
                    </button>
                    <button className="theia-button primary" onClick={create} disabled={!canCreate}>
                        Create Project
                    </button>
                </div>
            </div>
        </div>
    );
}
