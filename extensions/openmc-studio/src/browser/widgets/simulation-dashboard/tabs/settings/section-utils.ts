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
 * Parse a whitespace/comma-separated number list from a text input.
 * Invalid tokens are dropped.
 * @param raw - Raw input text.
 * @returns Parsed numbers.
 */
export function parseNumberList(raw: string): number[] {
    return raw
        .split(/[\s,]+/)
        .filter((token) => token.length > 0)
        .map(Number)
        .filter((n) => !isNaN(n));
}

/**
 * Parse a whitespace/comma-separated string list from a text input.
 * @param raw - Raw input text.
 * @returns Parsed strings.
 */
export function parseStringList(raw: string): string[] {
    return raw.split(/[\s,]+/).filter((token) => token.length > 0);
}

/**
 * Compare two primitive arrays element-wise.
 * @param a - First array.
 * @param b - Second array.
 * @returns Whether both arrays hold equal values in the same order.
 */
export function arraysEqual<T>(a: T[], b: T[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}
