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
}

export const Tooltip: React.FC<TooltipProps> = ({ content, children, position = 'top', delay = 300 }) => {
    const [visible, setVisible] = React.useState(false);
    const [coords, setCoords] = React.useState<{ x: number; y: number } | null>(null);
    const timerRef = React.useRef<NodeJS.Timeout | null>(null);
    const childRef = React.useRef<HTMLSpanElement>(null);

    const showTooltip = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            if (childRef.current) {
                const rect = childRef.current.getBoundingClientRect();
                let x = rect.left + rect.width / 2;
                let y = rect.top;

                switch (position) {
                    case 'top':
                        y = rect.top - 8;
                        break;
                    case 'bottom':
                        y = rect.bottom + 8;
                        break;
                    case 'left':
                        x = rect.left - 8;
                        y = rect.top + rect.height / 2;
                        break;
                    case 'right':
                        x = rect.right + 8;
                        y = rect.top + rect.height / 2;
                        break;
                }

                setCoords({ x, y });
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

    const tooltipElement =
        visible && coords ? (
            <div
                className={`nuke-tooltip nuke-tooltip-${position}`}
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
            <span ref={childRef} onMouseEnter={showTooltip} onMouseLeave={hideTooltip}>
                {children}
            </span>
            {tooltipElement && ReactDOM.createPortal(tooltipElement, document.body)}
        </>
    );
};

// Simple hook-based tooltip for easier use with existing elements
export const useTooltip = (content: string, position: 'top' | 'bottom' | 'left' | 'right' = 'top') => {
    const [visible, setVisible] = React.useState(false);
    const [coords, setCoords] = React.useState({ x: 0, y: 0 });
    const timerRef = React.useRef<NodeJS.Timeout | null>(null);

    const onMouseEnter = (e: React.MouseEvent) => {
        const currentTarget = e.currentTarget as HTMLElement;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            if (!currentTarget) return;
            const rect = currentTarget.getBoundingClientRect();
            let x = rect.left + rect.width / 2;
            let y = rect.top;

            switch (position) {
                case 'top':
                    y = rect.top - 8;
                    break;
                case 'bottom':
                    y = rect.bottom + 8;
                    break;
                case 'left':
                    x = rect.left - 8;
                    y = rect.top + rect.height / 2;
                    break;
                case 'right':
                    x = rect.right + 8;
                    y = rect.top + rect.height / 2;
                    break;
            }

            setCoords({ x, y });
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

    const tooltipElement = visible
        ? ReactDOM.createPortal(
              <div
                  className={`nuke-tooltip nuke-tooltip-${position}`}
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
