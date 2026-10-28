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

import * as React from 'react';

/** Shared props for the OpenMC domain illustrations. */
export interface DomainIconProps {
    /** Rendered width and height in pixels. */
    size?: number;
    /** Extra class on the SVG root (e.g. a header-icon color hook). */
    className?: string;
}

const DOMAIN_ICON_DEFAULT_SIZE = 52;
const DOMAIN_ICON_STROKE_WIDTH = 2.5;

interface DomainIconSvgProps extends DomainIconProps {
    children: React.ReactNode;
}

/**
 * Line-art SVG frame shared by the domain icons: 64x64 viewBox, `currentColor`
 * strokes, and no fill, so the icon inherits surrounding text colors and works
 * on dark and light themes.
 */
const DomainIconSvg: React.FC<DomainIconSvgProps> = ({ size = DOMAIN_ICON_DEFAULT_SIZE, className, children }) => (
    <svg
        className={className}
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        stroke="currentColor"
        strokeWidth={DOMAIN_ICON_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
    >
        {children}
    </svg>
);

/**
 * Geometry hierarchy: a root cell/universe connected to two child cells, each
 * drawn as a rounded node with a center marker.
 */
export const DomainGeometryIcon: React.FC<DomainIconProps> = (props) => (
    <DomainIconSvg {...props}>
        <rect x="24" y="6" width="16" height="16" rx="4" />
        <circle cx="32" cy="14" r="2.5" />
        <path d="M32 22v6M32 28H15v10M32 28h17v10" />
        <rect x="7" y="38" width="16" height="16" rx="4" />
        <circle cx="15" cy="46" r="2.5" />
        <rect x="41" y="38" width="16" height="16" rx="4" />
        <circle cx="49" cy="46" r="2.5" />
    </DomainIconSvg>
);

/**
 * Statepoint file: a database cylinder with a small k-effective curve beside
 * it, echoing the k-effective plot shown for statepoints.
 */
export const DomainStatepointIcon: React.FC<DomainIconProps> = (props) => (
    <DomainIconSvg {...props}>
        <ellipse cx="25" cy="16" rx="14" ry="5.5" />
        <path d="M11 16v30c0 3 6.3 5.5 14 5.5s14-2.5 14-5.5V16" />
        <path d="M11 31c0 3 6.3 5.5 14 5.5s14-2.5 14-5.5" />
        <path d="M42 32c3 0 3.5-8 7-8s4 6 7 2" />
        <circle cx="42" cy="32" r="1.75" />
        <circle cx="56" cy="26" r="1.75" />
    </DomainIconSvg>
);

/**
 * Tally: a mesh grid with three tally bars of increasing height.
 */
export const DomainTallyIcon: React.FC<DomainIconProps> = (props) => (
    <DomainIconSvg {...props}>
        <rect x="6" y="9" width="26" height="26" rx="3" />
        <path d="M14.7 9v26M23.3 9v26M6 17.7h26M6 26.3h26" />
        <path d="M42 54V42M50 54V36M58 54V28" strokeWidth={4} />
    </DomainIconSvg>
);

/**
 * Particle restart: a curved particle track with hollow start and end dots.
 */
export const DomainParticleIcon: React.FC<DomainIconProps> = (props) => (
    <DomainIconSvg {...props}>
        <path d="M11 51c8 0 8-14 16-14s9-10 16-10 5-4 7-7" />
        <circle cx="11" cy="51" r="3.25" />
        <circle cx="50" cy="20" r="3.25" />
    </DomainIconSvg>
);
