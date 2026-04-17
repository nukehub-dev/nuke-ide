// *****************************************************************************
// Copyright (C) 2024 NukeHub and others.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

export const redLightTheme = {
    $schema: 'vscode://schemas/color-theme',
    name: 'Red Light',
    type: 'light',
    colors: {
        // Brand Colors - Red accent
        'focusBorder': '#d32f2f',
        'foreground': '#2c3e50',
        'descriptionForeground': '#5a6c7d',
        'errorForeground': '#d13b3b',
        
        // Button
        'button.background': '#e53935',
        'button.hoverBackground': '#d32f2f',
        'button.foreground': '#ffffff',
        'button.secondaryBackground': '#f2e2e2',
        'button.secondaryHoverBackground': '#e8d5d5',
        'button.secondaryForeground': '#2c3e50',
        
        // Links
        'textLink.foreground': '#d32f2f',
        'textLink.activeForeground': '#e53935',
        
        // Activity Bar
        'activityBar.background': '#fdf5f5',
        'activityBar.foreground': '#424242',
        'activityBar.activeBorder': '#d32f2f',
        'activityBar.border': '#eecaca',
        'activityBarBadge.background': '#d32f2f',
        'activityBarBadge.foreground': '#ffffff',
        
        // Side Bar
        'sideBar.background': '#fdf5f5',
        'sideBar.foreground': '#424242',
        'sideBarTitle.foreground': '#24292f',
        'sideBar.border': '#eecaca',
        'sideBarSectionHeader.background': '#f7eeee',
        'sideBarSectionHeader.foreground': '#24292f',
        'sideBarSectionHeader.border': '#eecaca',
        
        // Status Bar
        'statusBar.background': '#f7eeee',
        'statusBar.foreground': '#424242',
        'statusBar.border': '#eecaca',
        'statusBar.noFolderBackground': '#f7eeee',
        'statusBarItem.remoteBackground': '#d32f2f',
        'statusBarItem.remoteForeground': '#ffffff',
        'statusBarItem.hoverBackground': '#eecaca',
        'statusBarItem.activeBackground': '#dfc9c9',
        
        // Title Bar
        'titleBar.activeBackground': '#f7eeee',
        'titleBar.activeForeground': '#2c3e50',
        'titleBar.border': '#eecaca',
        'titleBar.inactiveBackground': '#f7eeee',
        'titleBar.inactiveForeground': '#6c757d',
        
        // Menubar
        'menubar.selectionBackground': '#eecaca',
        'menubar.selectionForeground': '#2c3e50',
        'menubar.selectionBorder': '#eecaca',
        'menu.background': '#ffffff',
        'menu.foreground': '#2c3e50',
        'menu.selectionBackground': '#eecaca',
        'menu.selectionForeground': '#2c3e50',
        'menu.selectionBorder': '#eecaca',
        'menu.separatorBackground': '#eecaca',
        
        // Lists
        'list.activeSelectionBackground': '#f7eeee',
        'list.activeSelectionForeground': '#2c3e50',
        'list.inactiveSelectionBackground': '#fdf5f5',
        'list.inactiveSelectionForeground': '#2c3e50',
        'list.hoverBackground': '#f7eeee',
        'list.hoverForeground': '#2c3e50',
        'list.highlightForeground': '#d32f2f',
        'list.focusBackground': '#f7eeee',
        'list.focusForeground': '#2c3e50',
        'list.focusOutline': '#d32f2f',
        
        // Input
        'input.background': '#ffffff',
        'input.foreground': '#2c3e50',
        'input.border': '#eecaca',
        'input.placeholderForeground': '#8c959f',
        'inputOption.activeBorder': '#d32f2f',
        'inputOption.activeBackground': '#d32f2f20',
        'inputValidation.infoBackground': '#e1f5fe',
        'inputValidation.infoBorder': '#0288d1',
        'inputValidation.warningBackground': '#fff8e1',
        'inputValidation.warningBorder': '#ffa000',
        'inputValidation.errorBackground': '#ffebee',
        'inputValidation.errorBorder': '#d32f2f',
        
        // Dropdown
        'dropdown.background': '#ffffff',
        'dropdown.foreground': '#2c3e50',
        'dropdown.border': '#eecaca',
        
        // Badge
        'badge.background': '#d32f2f',
        'badge.foreground': '#ffffff',
        
        // Progress Bar
        'progressBar.background': '#d32f2f',
        
        // Panel
        'panel.background': '#fdf5f5',
        'panel.border': '#eecaca',
        'panelTitle.activeForeground': '#2c3e50',
        'panelTitle.activeBorder': '#d32f2f',
        'panelTitle.inactiveForeground': '#6c757d',
        
        // Terminal
        'terminal.background': '#ffffff',
        'terminal.foreground': '#2c3e50',
        'terminal.border': '#eecaca',
        'terminal.selectionBackground': '#d32f2f30',
        
        // Tabs
        'tab.activeBackground': '#ffffff',
        'tab.activeForeground': '#2c3e50',
        'tab.activeBorder': '#d32f2f',
        'tab.activeBorderTop': '#d32f2f',
        'tab.inactiveBackground': '#f7eeee',
        'tab.inactiveForeground': '#6c757d',
        'tab.hoverBackground': '#fdf5f5',
        'tab.hoverForeground': '#2c3e50',
        'tab.border': '#eecaca',
        'tab.unfocusedActiveBorder': '#eecaca',
        'tab.unfocusedActiveBorderTop': '#eecaca',
        
        // Editor
        'editor.background': '#ffffff',
        'editor.foreground': '#2c3e50',
        'editorLineNumber.foreground': '#a59595',
        'editorLineNumber.activeForeground': '#24292f',
        'editor.selectionBackground': '#d32f2f20',
        'editor.selectionHighlightBackground': '#d32f2f15',
        'editor.wordHighlightBackground': '#d32f2f15',
        'editor.wordHighlightStrongBackground': '#d32f2f25',
        'editor.findMatchBackground': '#d32f2f40',
        'editor.findMatchHighlightBackground': '#d32f2f20',
        'editor.findRangeHighlightBackground': '#fcf0f0',
        'editor.hoverHighlightBackground': '#d32f2f15',
        'editorWidget.background': '#fdf5f5',
        'editorWidget.foreground': '#2c3e50',
        'editorWidget.border': '#eecaca',
        'editorWidget.resizeBorder': '#d32f2f',
        
        // Breadcrumb
        'breadcrumb.background': '#ffffff',
        'breadcrumb.foreground': '#6c757d',
        'breadcrumb.focusForeground': '#2c3e50',
        'breadcrumb.activeSelectionForeground': '#2c3e50',
        'breadcrumbPicker.background': '#fdf5f5',
        
        // Picker
        'pickerGroup.foreground': '#d32f2f',
        'pickerGroup.border': '#eecaca',
        'quickInput.background': '#fdf5f5',
        'quickInput.foreground': '#2c3e50',
        'quickInputList.focusBackground': '#eecaca',
        'quickInputList.focusForeground': '#2c3e50',
        
        // Notifications
        'notificationCenter.border': '#eecaca',
        'notificationCenterHeader.foreground': '#2c3e50',
        'notificationCenterHeader.background': '#fdf5f5',
        'notificationToast.border': '#eecaca',
        'notifications.foreground': '#2c3e50',
        'notifications.background': '#fdf5f5',
        'notifications.border': '#eecaca',
        'notificationLink.foreground': '#d32f2f',
        
        // Settings
        'settings.headerForeground': '#2c3e50',
        'settings.modifiedItemIndicator': '#d32f2f',
        'settings.dropdownBackground': '#ffffff',
        'settings.dropdownForeground': '#2c3e50',
        'settings.dropdownBorder': '#eecaca',
        'settings.checkboxBackground': '#ffffff',
        'settings.checkboxForeground': '#2c3e50',
        'settings.checkboxBorder': '#eecaca',
        'settings.textInputBackground': '#ffffff',
        'settings.textInputForeground': '#2c3e50',
        'settings.textInputBorder': '#eecaca',
        'settings.numberInputBackground': '#ffffff',
        'settings.numberInputForeground': '#2c3e50',
        'settings.numberInputBorder': '#eecaca',
        
        // Scrollbar
        'scrollbar.shadow': '#eecaca',
        'scrollbarSlider.background': '#d32f2f20',
        'scrollbarSlider.hoverBackground': '#d32f2f30',
        'scrollbarSlider.activeBackground': '#d32f2f40',
        
        // Keybinding
        'keybindingLabel.background': '#f7eeee',
        'keybindingLabel.foreground': '#2c3e50',
        'keybindingLabel.border': '#eecaca',
        'keybindingLabel.bottomBorder': '#eecaca',
    },
    tokenColors: [],
    semanticHighlighting: true
};
