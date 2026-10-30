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
import * as ReactDOM from '@theia/core/shared/react-dom';

interface TooltipProps {
    content: string;
    children: React.ReactNode;
    position?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number;
    /**
     * Stretch the wrapper to the container width instead of hugging the
     * content: for full-width rows (the viewer color-legend bar) whose
     * inner flex layout needs the whole line — a hugging wrapper collapses
     * `flex: 1` children (the gradient) to zero width. The tooltip then
     * anchors centered on the row.
     */
    stretch?: boolean;
}

type TooltipPosition = 'top' | 'bottom' | 'left' | 'right';

/**
 * Viewport-aware anchor: flip the requested side when the anchor sits close
 * to that viewport edge (right-area sidebars always overflow `right`), then
 * clamp so the fixed tooltip can never be cut out by the window edge.
 */
function resolveTooltipPlacement(rect: DOMRect, position: TooltipPosition): { x: number; y: number; position: TooltipPosition } {
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let effective = position;
    // Preemptive flip: a `right` tooltip anchored in the right third of the
    // viewport (the right sidebar) would extend past the window edge, so
    // show it on the left instead (and mirror for the other sides).
    if (position === 'right' && rect.right + 160 > vw) {
        effective = 'left';
    } else if (position === 'left' && rect.left - 160 < 0) {
        effective = 'right';
    } else if (position === 'top' && rect.top - 48 < 0) {
        effective = 'bottom';
    } else if (position === 'bottom' && rect.bottom + 48 > vh) {
        effective = 'top';
    }
    let x = rect.left + rect.width / 2;
    let y = rect.top;
    switch (effective) {
        case 'top':
            y = rect.top - margin;
            break;
        case 'bottom':
            y = rect.bottom + margin;
            break;
        case 'left':
            x = rect.left - margin;
            y = rect.top + rect.height / 2;
            break;
        case 'right':
            x = rect.right + margin;
            y = rect.top + rect.height / 2;
            break;
    }
    return {
        x: Math.min(Math.max(x, margin), Math.max(vw - margin, margin)),
        y: Math.min(Math.max(y, margin), Math.max(vh - margin, margin)),
        position: effective
    };
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children, position = 'top', delay = 300, stretch = false }) => {
    const [visible, setVisible] = React.useState(false);
    const [coords, setCoords] = React.useState<{ x: number; y: number } | null>(null);
    const [effectivePosition, setEffectivePosition] = React.useState<TooltipPosition>(position);
    const timerRef = React.useRef<NodeJS.Timeout | null>(null);
    const childRef = React.useRef<HTMLSpanElement>(null);

    const showTooltip = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            if (childRef.current) {
                const rect = childRef.current.getBoundingClientRect();
                const placement = resolveTooltipPlacement(rect, position);
                setEffectivePosition(placement.position);
                setCoords({ x: placement.x, y: placement.y });
                setVisible(true);
            }
        }, delay);
    };

    const hideTooltip = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setVisible(false);
    };

    React.useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    // Hide the tooltip when the page (or any scrolling container) scrolls or
    // the window resizes: the anchor coordinates are computed at show time and
    // would otherwise float over unrelated content.
    React.useEffect(() => {
        if (!visible) return;
        const hide = () => setVisible(false);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [visible]);

    const tooltipElement =
        visible && coords ? (
            <div
                className={`nuke-tooltip nuke-tooltip-${effectivePosition}`}
                style={{
                    position: 'fixed',
                    left: coords.x,
                    top: coords.y,
                    zIndex: 99999
                }}
            >
                {content}
            </div>
        ) : null;

    return (
        <>
            <span
                ref={childRef}
                onMouseEnter={showTooltip}
                onMouseLeave={hideTooltip}
                onMouseDown={hideTooltip}
                // Hug the anchored content: in stretchy flex-column containers a
                // plain inline span inflates to the full container width, which
                // would position the tooltip against that inflated rect instead
                // of the actual control. `stretch` opts out for full-width rows
                // (viewer color legend) whose inner flex layout needs the line.
                style={
                    stretch
                        ? { display: 'block', width: '100%', maxWidth: '100%' }
                        : { display: 'inline-flex', alignItems: 'center', width: 'fit-content', maxWidth: '100%' }
                }
            >
                {children}
            </span>
            {tooltipElement && ReactDOM.createPortal(tooltipElement, document.body)}
        </>
    );
};

// Simple hook-based tooltip for easier use with existing elements
export const useTooltip = (content: string, position: TooltipPosition = 'top') => {
    const [visible, setVisible] = React.useState(false);
    const [coords, setCoords] = React.useState({ x: 0, y: 0 });
    const [effectivePosition, setEffectivePosition] = React.useState<TooltipPosition>(position);
    const timerRef = React.useRef<NodeJS.Timeout | null>(null);

    const onMouseEnter = (e: React.MouseEvent) => {
        const currentTarget = e.currentTarget as HTMLElement;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            if (!currentTarget) return;
            const rect = currentTarget.getBoundingClientRect();
            const placement = resolveTooltipPlacement(rect, position);
            setEffectivePosition(placement.position);
            setCoords({ x: placement.x, y: placement.y });
            setVisible(true);
        }, 300);
    };

    const onMouseLeave = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setVisible(false);
    };

    React.useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    // Hide the tooltip when the page (or any scrolling container) scrolls or
    // the window resizes: the anchor coordinates are computed at show time.
    React.useEffect(() => {
        if (!visible) return;
        const hide = () => setVisible(false);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [visible]);

    const tooltipElement = visible
        ? ReactDOM.createPortal(
              <div
                  className={`nuke-tooltip nuke-tooltip-${effectivePosition}`}
                  style={{
                      position: 'fixed',
                      left: coords.x,
                      top: coords.y,
                      zIndex: 99999
                  }}
              >
                  {content}
              </div>,
              document.body
          )
        : null;

    return { onMouseEnter, onMouseLeave, tooltipElement };
};
