// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

export const redDarkTheme = {
    $schema: 'vscode://schemas/color-theme',
    name: 'Red Dark',
    type: 'dark',
    colors: {
        // Brand Colors - Red accent
        'focusBorder': '#e53935',
        'foreground': '#d4d4d4',
        'descriptionForeground': '#9ca3af',
        'errorForeground': '#f48771',
        
        // Button - Primary red, secondary gray
        'button.background': '#e53935',
        'button.hoverBackground': '#ef5350',
        'button.foreground': '#ffffff',
        'button.secondaryBackground': '#4a4a4a',
        'button.secondaryHoverBackground': '#5a5a5a',
        'button.secondaryForeground': '#ffffff',
        
        // Links
        'textLink.foreground': '#e53935',
        'textLink.activeForeground': '#ef5350',
        
        // Activity Bar
        'activityBar.background': '#1a1a1a',
        'activityBar.foreground': '#d4d4d4',
        'activityBar.activeBorder': '#e53935',
        'activityBar.border': '#333333',
        'activityBarBadge.background': '#e53935',
        'activityBarBadge.foreground': '#ffffff',
        
        // Side Bar
        'sideBar.background': '#1e1e1e',
        'sideBar.foreground': '#d4d4d4',
        'sideBarTitle.foreground': '#bbbbbb',
        'sideBar.border': '#333333',
        'sideBarSectionHeader.background': '#252526',
        'sideBarSectionHeader.foreground': '#bbbbbb',
        
        // Status Bar
        'statusBar.background': '#1a1a1a',
        'statusBar.foreground': '#d4d4d4',
        'statusBar.border': '#333333',
        'statusBar.noFolderBackground': '#1a1a1a',
        'statusBarItem.remoteBackground': '#4a4a4a',
        'statusBarItem.remoteForeground': '#ffffff',
        'statusBarItem.hoverBackground': '#333333',
        'statusBarItem.activeBackground': '#444444',
        
        // Title Bar
        'titleBar.activeBackground': '#1a1a1a',
        'titleBar.activeForeground': '#cccccc',
        'titleBar.border': '#333333',
        'titleBar.inactiveBackground': '#1a1a1a',
        'titleBar.inactiveForeground': '#808080',
        
        // Menubar
        'menubar.selectionBackground': '#5a5a5a',
        'menubar.selectionForeground': '#ffffff',
        'menubar.selectionBorder': '#5a5a5a',
        'menu.background': '#252526',
        'menu.foreground': '#cccccc',
        'menu.selectionBackground': '#5a5a5a',
        'menu.selectionForeground': '#ffffff',
        'menu.selectionBorder': '#5a5a5a',
        'menu.separatorBackground': '#444444',
        
        // Lists
        'list.activeSelectionBackground': '#37373d',
        'list.activeSelectionForeground': '#ffffff',
        'list.inactiveSelectionBackground': '#37373d',
        'list.inactiveSelectionForeground': '#cccccc',
        'list.hoverBackground': '#2a2d2e',
        'list.hoverForeground': '#cccccc',
        'list.highlightForeground': '#e53935',
        'list.focusBackground': '#2a2d2e',
        'list.focusForeground': '#cccccc',
        'list.focusOutline': '#e53935',
        
        // Input
        'input.background': '#3c3c3c',
        'input.foreground': '#cccccc',
        'input.border': '#3c3c3c',
        'input.placeholderForeground': '#808080',
        'inputOption.activeBorder': '#e53935',
        'inputOption.activeBackground': '#e5393530',
        'inputValidation.infoBackground': '#063b49',
        'inputValidation.infoBorder': '#007acc',
        'inputValidation.warningBackground': '#352a05',
        'inputValidation.warningBorder': '#b89500',
        'inputValidation.errorBackground': '#5a1d1d',
        'inputValidation.errorBorder': '#be1100',
        
        // Dropdown
        'dropdown.background': '#3c3c3c',
        'dropdown.foreground': '#cccccc',
        'dropdown.border': '#3c3c3c',
        
        // Badge
        'badge.background': '#e53935',
        'badge.foreground': '#ffffff',
        
        // Progress Bar
        'progressBar.background': '#e53935',
        
        // Panel
        'panel.background': '#1e1e1e',
        'panel.border': '#333333',
        'panelTitle.activeForeground': '#cccccc',
        'panelTitle.activeBorder': '#e53935',
        'panelTitle.inactiveForeground': '#808080',
        
        // Terminal
        'terminal.background': '#1e1e1e',
        'terminal.foreground': '#d4d4d4',
        'terminal.border': '#333333',
        'terminal.selectionBackground': '#e5393540',
        
        // Tabs
        'tab.activeBackground': '#1e1e1e',
        'tab.activeForeground': '#ffffff',
        'tab.activeBorder': '#e53935',
        'tab.activeBorderTop': '#e53935',
        'tab.inactiveBackground': '#2d2d2d',
        'tab.inactiveForeground': '#808080',
        'tab.hoverBackground': '#2d2d2d',
        'tab.hoverForeground': '#cccccc',
        'tab.border': '#252526',
        'tab.unfocusedActiveBorder': '#333333',
        'tab.unfocusedActiveBorderTop': '#333333',
        
        // Editor
        'editor.background': '#1e1e1e',
        'editor.foreground': '#d4d4d4',
        'editorLineNumber.foreground': '#858585',
        'editorLineNumber.activeForeground': '#c6c6c6',
        'editor.selectionBackground': '#e5393540',
        'editor.selectionHighlightBackground': '#e5393520',
        'editor.wordHighlightBackground': '#e5393520',
        'editor.wordHighlightStrongBackground': '#e5393530',
        'editor.findMatchBackground': '#e5393560',
        'editor.findMatchHighlightBackground': '#e5393530',
        'editor.findRangeHighlightBackground': '#3a3d4166',
        'editor.hoverHighlightBackground': '#e5393520',
        'editorWidget.background': '#252526',
        'editorWidget.foreground': '#cccccc',
        'editorWidget.border': '#454545',
        'editorWidget.resizeBorder': '#e53935',
        
        // Breadcrumb
        'breadcrumb.background': '#1a1111',
        'breadcrumb.foreground': '#ccccccb3',
        'breadcrumb.focusForeground': '#e0e0e0',
        'breadcrumb.activeSelectionForeground': '#e0e0e0',
        'breadcrumbPicker.background': '#252526',
        
        // Picker
        'pickerGroup.foreground': '#e53935',
        'pickerGroup.border': '#3f3f46',
        'quickInput.background': '#252526',
        'quickInput.foreground': '#cccccc',
        'quickInputList.focusBackground': '#5a5a5a',
        'quickInputList.focusForeground': '#ffffff',
        
        // Notifications
        'notificationCenter.border': '#333333',
        'notificationCenterHeader.foreground': '#cccccc',
        'notificationCenterHeader.background': '#252526',
        'notificationToast.border': '#333333',
        'notifications.foreground': '#cccccc',
        'notifications.background': '#252526',
        'notifications.border': '#333333',
        'notificationLink.foreground': '#e53935',
        
        // Settings
        'settings.headerForeground': '#ffffff',
        'settings.modifiedItemIndicator': '#e53935',
        'settings.dropdownBackground': '#3c3c3c',
        'settings.dropdownForeground': '#cccccc',
        'settings.dropdownBorder': '#3c3c3c',
        'settings.checkboxBackground': '#3c3c3c',
        'settings.checkboxForeground': '#cccccc',
        'settings.checkboxBorder': '#3c3c3c',
        'settings.textInputBackground': '#3c3c3c',
        'settings.textInputForeground': '#cccccc',
        'settings.textInputBorder': '#3c3c3c',
        'settings.numberInputBackground': '#3c3c3c',
        'settings.numberInputForeground': '#cccccc',
        'settings.numberInputBorder': '#3c3c3c',
        
        // Scrollbar
        'scrollbar.shadow': '#000000',
        'scrollbarSlider.background': '#5a5a5a40',
        'scrollbarSlider.hoverBackground': '#5a5a5a60',
        'scrollbarSlider.activeBackground': '#5a5a5a80',
        
        // Keybinding
        'keybindingLabel.background': '#3c3c3c',
        'keybindingLabel.foreground': '#cccccc',
        'keybindingLabel.border': '#3c3c3c',
        'keybindingLabel.bottomBorder': '#3c3c3c',
    },
    tokenColors: [],
    semanticHighlighting: true
};
