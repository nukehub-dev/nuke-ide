import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['extensions/*/src/**/*.test.ts', 'extensions/*/src/**/*.test.tsx', 'scripts/*.test.js'],
        environment: 'node'
    }
});
