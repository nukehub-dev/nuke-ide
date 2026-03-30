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

import * as React from '@theia/core/shared/react';
import * as ReactDOM from '@theia/core/shared/react-dom';

interface TooltipProps {
    content: string;
    children: React.ReactNode;
    position?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
    content,
    children,
    position = 'top',
    delay = 300
}) => {
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

    const tooltipElement = visible && coords ? (
        <div
            className={`nuke-tooltip nuke-tooltip-${position}`}
            style={{
                position: 'fixed',
                left: coords.x,
                top: coords.y,
                zIndex: 99999,
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
            >
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
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
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

    const tooltipElement = visible ? (
        ReactDOM.createPortal(
            <div
                className={`nuke-tooltip nuke-tooltip-${position}`}
                style={{
                    position: 'fixed',
                    left: coords.x,
                    top: coords.y,
                    zIndex: 99999,
                }}
            >
                {content}
            </div>,
            document.body
        )
    ) : null;

    return { onMouseEnter, onMouseLeave, tooltipElement };
};
