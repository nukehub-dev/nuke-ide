// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

export const lightTheme = {
    $schema: 'vscode://schemas/color-theme',
    name: 'Light',
    type: 'light',
    colors: {
        // Brand Colors - Orange accent
        'focusBorder': '#e06010',
        'foreground': '#2c3e50',
        'descriptionForeground': '#5a6c7d',
        'errorForeground': '#d13b3b',
        
        // Button
        'button.background': '#f37524',
        'button.hoverBackground': '#e06010',
        'button.foreground': '#ffffff',
        'button.secondaryBackground': '#e4e4e4',
        'button.secondaryHoverBackground': '#d4d4d4',
        'button.secondaryForeground': '#2c3e50',
        
        // Links
        'textLink.foreground': '#e06010',
        'textLink.activeForeground': '#f37524',
        
        // Activity Bar
        'activityBar.background': '#f3f3f3',
        'activityBar.foreground': '#424242',
        'activityBar.activeBorder': '#f37524',
        'activityBar.border': '#d4d4d4',
        'activityBarBadge.background': '#4a4a4a',
        'activityBarBadge.foreground': '#ffffff',
        
        // Side Bar
        'sideBar.background': '#f3f3f3',
        'sideBar.foreground': '#424242',
        'sideBarTitle.foreground': '#24292f',
        'sideBar.border': '#d4d4d4',
        'sideBarSectionHeader.background': '#e8e8e8',
        'sideBarSectionHeader.foreground': '#24292f',
        'sideBarSectionHeader.border': '#d4d4d4',
        
        // Status Bar
        'statusBar.background': '#eeeeee',
        'statusBar.foreground': '#424242',
        'statusBar.border': '#d4d4d4',
        'statusBar.noFolderBackground': '#eeeeee',
        'statusBarItem.remoteBackground': '#4a4a4a',
        'statusBarItem.remoteForeground': '#ffffff',
        'statusBarItem.hoverBackground': '#d4d4d4',
        'statusBarItem.activeBackground': '#d0d7de',
        
        // Title Bar
        'titleBar.activeBackground': '#eeeeee',
        'titleBar.activeForeground': '#2c3e50',
        'titleBar.border': '#d4d4d4',
        'titleBar.inactiveBackground': '#eeeeee',
        'titleBar.inactiveForeground': '#6c757d',
        
        // Menubar
        'menubar.selectionBackground': '#e1e4e8',
        'menubar.selectionForeground': '#2c3e50',
        'menubar.selectionBorder': '#e1e4e8',
        'menu.background': '#ffffff',
        'menu.foreground': '#2c3e50',
        'menu.selectionBackground': '#e1e4e8',
        'menu.selectionForeground': '#2c3e50',
        'menu.selectionBorder': '#e1e4e8',
        'menu.separatorBackground': '#e1e4e8',
        
        // Lists
        'list.activeSelectionBackground': '#e0e0e0',
        'list.activeSelectionForeground': '#2c3e50',
        'list.inactiveSelectionBackground': '#eeeeee',
        'list.inactiveSelectionForeground': '#2c3e50',
        'list.hoverBackground': '#e8e8e8',
        'list.hoverForeground': '#2c3e50',
        'list.highlightForeground': '#e06010',
        'list.focusBackground': '#eeeeee',
        'list.focusForeground': '#2c3e50',
        'list.focusOutline': '#e06010',
        
        // Input
        'input.background': '#ffffff',
        'input.foreground': '#2c3e50',
        'input.border': '#d4d4d4',
        'input.placeholderForeground': '#8c959f',
        'inputOption.activeBorder': '#f37524',
        'inputOption.activeBackground': '#4a4a4a30',
        'inputValidation.infoBackground': '#e1f5fe',
        'inputValidation.infoBorder': '#0288d1',
        'inputValidation.warningBackground': '#fff8e1',
        'inputValidation.warningBorder': '#ffa000',
        'inputValidation.errorBackground': '#ffebee',
        'inputValidation.errorBorder': '#d32f2f',
        
        // Dropdown
        'dropdown.background': '#ffffff',
        'dropdown.foreground': '#2c3e50',
        'dropdown.border': '#d4d4d4',
        
        // Badge
        'badge.background': '#f37524',
        'badge.foreground': '#ffffff',
        
        // Progress Bar
        'progressBar.background': '#f37524',
        
        // Panel
        'panel.background': '#f3f3f3',
        'panel.border': '#d4d4d4',
        'panelTitle.activeForeground': '#2c3e50',
        'panelTitle.activeBorder': '#f37524',
        'panelTitle.inactiveForeground': '#6c757d',
        
        // Terminal
        'terminal.background': '#ffffff',
        'terminal.foreground': '#2c3e50',
        'terminal.border': '#d4d4d4',
        'terminal.selectionBackground': '#add6ff66',
        
        // Tabs
        'tab.activeBackground': '#ffffff',
        'tab.activeForeground': '#2c3e50',
        'tab.activeBorder': '#f37524',
        'tab.activeBorderTop': '#f37524',
        'tab.inactiveBackground': '#e8e8e8',
        'tab.inactiveForeground': '#6c757d',
        'tab.hoverBackground': '#f0f0f0',
        'tab.hoverForeground': '#2c3e50',
        'tab.border': '#d4d4d4',
        'tab.unfocusedActiveBorder': '#d4d4d4',
        'tab.unfocusedActiveBorderTop': '#d4d4d4',
        
        // Editor
        'editor.background': '#ffffff',
        'editor.foreground': '#2c3e50',
        'editorLineNumber.foreground': '#6e7681',
        'editorLineNumber.activeForeground': '#24292f',
        'editor.selectionBackground': '#add6ff',
        'editor.selectionHighlightBackground': '#add6ff66',
        'editor.wordHighlightBackground': '#d4d4d480',
        'editor.wordHighlightStrongBackground': '#add6ff80',
        'editor.findMatchBackground': '#a8ac94',
        'editor.findMatchHighlightBackground': '#ea5c0030',
        'editor.findRangeHighlightBackground': '#d4d4d440',
        'editor.hoverHighlightBackground': '#add6ff40',
        'editorWidget.background': '#f3f3f3',
        'editorWidget.foreground': '#2c3e50',
        'editorWidget.border': '#d4d4d4',
        'editorWidget.resizeBorder': '#e06010',
        
        // Breadcrumb
        'breadcrumb.background': '#ffffff',
        'breadcrumb.foreground': '#6c757d',
        'breadcrumb.focusForeground': '#2c3e50',
        'breadcrumb.activeSelectionForeground': '#2c3e50',
        'breadcrumbPicker.background': '#f3f3f3',
        
        // Picker
        'pickerGroup.foreground': '#e06010',
        'pickerGroup.border': '#d4d4d4',
        'quickInput.background': '#f3f3f3',
        'quickInput.foreground': '#2c3e50',
        'quickInputList.focusBackground': '#e1e4e8',
        'quickInputList.focusForeground': '#2c3e50',
        
        // Notifications
        'notificationCenter.border': '#d4d4d4',
        'notificationCenterHeader.foreground': '#2c3e50',
        'notificationCenterHeader.background': '#f3f3f3',
        'notificationToast.border': '#d4d4d4',
        'notifications.foreground': '#2c3e50',
        'notifications.background': '#f3f3f3',
        'notifications.border': '#d4d4d4',
        'notificationLink.foreground': '#e06010',
        
        // Settings
        'settings.headerForeground': '#2c3e50',
        'settings.modifiedItemIndicator': '#4a4a4a',
        'settings.dropdownBackground': '#ffffff',
        'settings.dropdownForeground': '#2c3e50',
        'settings.dropdownBorder': '#d4d4d4',
        'settings.checkboxBackground': '#ffffff',
        'settings.checkboxForeground': '#2c3e50',
        'settings.checkboxBorder': '#d4d4d4',
        'settings.textInputBackground': '#ffffff',
        'settings.textInputForeground': '#2c3e50',
        'settings.textInputBorder': '#d4d4d4',
        'settings.numberInputBackground': '#ffffff',
        'settings.numberInputForeground': '#2c3e50',
        'settings.numberInputBorder': '#d4d4d4',
        
        // Scrollbar
        'scrollbar.shadow': '#d4d4d4',
        'scrollbarSlider.background': '#6c757d30',
        'scrollbarSlider.hoverBackground': '#6c757d50',
        'scrollbarSlider.activeBackground': '#6c757d70',
        
        // Keybinding
        'keybindingLabel.background': '#e4e4e4',
        'keybindingLabel.foreground': '#2c3e50',
        'keybindingLabel.border': '#d4d4d4',
        'keybindingLabel.bottomBorder': '#d4d4d4',
    },
    tokenColors: [],
    semanticHighlighting: true
};
