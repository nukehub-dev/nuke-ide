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

import * as React from '@theia/core/shared/react';
import { NukeBadge } from 'nuke-essentials/lib/theme/browser/components';

import type { GeometryIssueSummary } from '../../../common/geometry-editor';
import type { ValidationIssue } from '../../../common/openmc-studio-protocol';

export interface CSGValidationBannerProps {
    /** Grouped issues from `summarizeGeometryIssues`. */
    summary: GeometryIssueSummary;
    /** Switch to the owning tab and focus the affected field. */
    onIssueClick: (issue: ValidationIssue) => void;
}

/**
 * Geometry-wide validation banner. Errors block a run; warnings are surfaced
 * without claiming the model is blocked. The list is grouped by tab and each
 * row is an actionable button that routes to the owning editor field.
 */
export const CSGValidationBanner: React.FC<CSGValidationBannerProps> = ({ summary, onIssueClick }) => {
    const hasErrors = summary.errors > 0;
    const [expanded, setExpanded] = React.useState(hasErrors);

    React.useEffect(() => {
        if (hasErrors) {
            setExpanded(true);
        }
    }, [hasErrors]);

    if (summary.errors === 0 && summary.warnings === 0) {
        return null;
    }

    const count = summary.errors + summary.warnings;
    const title = hasErrors
        ? summary.errors === 1
            ? '1 issue blocks this model'
            : `${summary.errors} issues block this model`
        : `No blocking issues · ${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`;

    return (
        <section
            className={`csg-validation-banner ${hasErrors ? 'error' : 'warning'}`}
            aria-label="Geometry validation"
            data-severity={hasErrors ? 'error' : 'warning'}
        >
            <div className="csg-validation-summary">
                <i className={`codicon codicon-${hasErrors ? 'error' : 'warning'} csg-validation-icon`} aria-hidden="true"></i>
                <div className="csg-validation-copy">
                    <span className="csg-validation-title" role="status">
                        {title}
                    </span>
                    <span className="csg-validation-subtitle">
                        {hasErrors
                            ? 'Fix these before running. Click an issue to jump to its tab and field.'
                            : 'These do not block a run, but OpenMC may warn or ignore the affected setting.'}
                    </span>
                </div>
                <NukeBadge className="csg-validation-count">{count}</NukeBadge>
                <button
                    type="button"
                    className="theia-button secondary small csg-validation-toggle"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                >
                    <i className={`codicon codicon-chevron-${expanded ? 'up' : 'down'}`} aria-hidden="true"></i>
                    {expanded ? 'Hide details' : 'Show details'}
                </button>
            </div>

            {expanded && (
                <div className="csg-validation-groups">
                    {summary.groups.map((group) => (
                        <div key={group.tab} className="csg-validation-group" data-tab={group.tab}>
                            <div className="csg-validation-group-header">
                                <span>{group.label}</span>
                                <NukeBadge className="csg-validation-group-count">{group.issues.length}</NukeBadge>
                            </div>
                            <ul className="csg-validation-issues">
                                {group.issues.map((issue, index) => (
                                    <li key={`${group.tab}-${index}-${issue.message}`}>
                                        <button
                                            type="button"
                                            className={`csg-validation-issue ${issue.severity}`}
                                            onClick={() => onIssueClick(issue)}
                                        >
                                            <i
                                                className={`codicon codicon-${issue.severity === 'error' ? 'error' : 'warning'}`}
                                                aria-hidden="true"
                                            ></i>
                                            <span className="csg-validation-issue-text">
                                                <span className="csg-validation-issue-message">{issue.message}</span>
                                                {issue.suggestion && (
                                                    <span className="csg-validation-issue-suggestion">{issue.suggestion}</span>
                                                )}
                                            </span>
                                            <i className="codicon codicon-arrow-right" aria-hidden="true"></i>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};
