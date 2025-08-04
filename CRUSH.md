# CRUSH.md - NukeIDE Project Guidelines

This file outlines the essential commands and code style conventions for the NukeIDE project, to assist agentic coding tools.

## Build/Lint/Test Commands

- **Overall Build**: `yarn` (from root) to install dependencies, then `lerna run build` for all packages.
- **Clean**: `lerna run clean`
- **Type Check/Lint**: `lerna run build` or `tsc` in individual extension directories.
- **Run Browser Application**: `yarn start:browser` (from root)
- **Run Electron Application**: `yarn start:electron` (from root)
- **Build Browser Application**: `yarn build:browser` (from root)
- **Build Electron Application**: `yarn build:electron` (from root)
- **Watch mode for Browser Application**: `yarn watch:browser` (from root)
- **Watch mode for Electron Application**: `yarn watch:electron` (from root)
- **Extension Build**: From an extension's directory (e.g., `extensions/nuke-essentials`), run `yarn build` or `tsc`.
- **Extension Watch**: From an extension's directory, run `yarn watch` or `tsc -w`.
- **Running Tests**: This project uses `@theia/test`. To run all tests for the browser application, navigate to `applications/browser` and run `theia test`. To run single tests, you will likely need to modify the `theia test` command with specific test file paths or names, if supported by the Theia testing framework.
- **Troubleshooting `yarn install`**: If `puppeteer` download fails during `yarn install`, try running `PUPPETEER_SKIP_DOWNLOAD=true yarn` to skip the browser download.

## Code Style Guidelines (TypeScript/React)

- **Imports**: Organize imports with external modules first, then internal modules, grouped by relative paths. Use absolute imports for Theia modules.
- **Formatting**: Adhere to Prettier or ESLint rules if configured (check `.eslintrc.js` or `prettier.config.js` if they exist). Default to a consistent 2-space indentation.
- **Types**: Use TypeScript consistently. Explicitly define types for function arguments, return values, and complex object structures. Prefer interfaces for object types.
- **Naming Conventions**:
  - Variables/Functions: `camelCase`
  - Classes/Interfaces/Types: `PascalCase`
  - Constants: `SCREAMING_SNAKE_CASE` (for global constants)
- **Error Handling**: Use `try-catch` blocks for asynchronous operations and potential runtime errors. Propagate errors clearly through function signatures or custom error classes.
- **React Components**: Prefer functional components with hooks. Use descriptive prop types.

## Agent Specific Rules

### Copilot Instructions

No Copilot instructions found in `.github/copilot-instructions.md`.

### Cursor Rules

No Cursor rules found in `.cursor/rules/` or `.cursorrules`.
