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
 * Public component-template types.
 *
 * @module nuke-cad/common
 */

import type { NukeCadDocument } from '../cad-document';

/** Catalog grouping for a component template. */
export type ComponentTemplateCategory = 'primitives' | 'mechanical' | 'nuclear' | 'assembly';

/** Physical family of a template parameter. */
export type ComponentParameterKind = 'length' | 'angle' | 'ratio' | 'count';

/** Unit a template parameter is declared in and validated against. */
export type ComponentTemplateUnit = 'mm' | 'cm' | 'm' | 'deg' | '1';

/** One typed, validated input of a component template. */
export interface ComponentTemplateParameter {
    readonly name: string;
    readonly label: string;
    readonly kind: ComponentParameterKind;
    readonly unit: ComponentTemplateUnit;
    readonly default: number;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
    readonly description?: string;
    /** Counterpart parameter name (radius <-> diameter). */
    readonly pair?: string;
    /** Store this input into another document parameter with a factor (diameter -> radius: factor 0.5). */
    readonly derived?: { readonly parameter: string; readonly factor: number };
}

/** A shipped parametric component template. */
export interface ComponentTemplate {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly category: ComponentTemplateCategory;
    readonly keywords: readonly string[];
    readonly parameters: readonly ComponentTemplateParameter[];
    /** Fully validated template body; must declare `units` and carry no import features. */
    readonly document: NukeCadDocument;
}

/** One parameter after defaults, pairs, and unit conversions are resolved. */
export interface ResolvedComponentParameter {
    readonly name: string;
    readonly label: string;
    readonly kind: ComponentParameterKind;
    readonly unit: ComponentTemplateUnit;
    /** Value in document units, for the resolved document. */
    readonly value: number;
    /** Value in the parameter's declared unit (what the caller supplied). */
    readonly inputValue: number;
    /** Template default in document units. */
    readonly defaultValue: number;
    /** True when the value came from a default or a pair rather than a direct input. */
    readonly derived: boolean;
    /** Optional bounds converted to document units. */
    readonly min?: number;
    readonly max?: number;
}

/** Resolution result for one template and its overrides. */
export type ComponentTemplateResolveResult =
    | {
          readonly ok: true;
          /** Document parameter names mapped to values in document units (derived aliases are folded into their target). */
          readonly values: Readonly<Record<string, number>>;
          /** Every declared template parameter in declaration order. */
          readonly resolved: readonly ResolvedComponentParameter[];
      }
    | { readonly ok: false; readonly message: string };
