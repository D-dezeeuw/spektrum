// Flat config (ESLint v9+). One block covers both browser and node code,
// since the union of globals is small.
export default [
  {
    ignores: ['node_modules/**', 'spektrum.min.js'],
  },
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // browser
        document: 'readonly',
        window: 'readonly',
        requestAnimationFrame: 'readonly',
        NodeFilter: 'readonly',
        HTMLElement: 'readonly',
        // shared
        console: 'readonly',
        // node (tests, this config)
        process: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'prefer-const': 'warn',
      'no-var': 'error',
      'eqeqeq': ['warn', 'smart'],
    },
  },
];
