import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['extensions/*/src/**/*.test.ts', 'scripts/*.test.js'],
        environment: 'node'
    }
});
