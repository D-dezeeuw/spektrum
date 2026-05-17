// Flat config (ESLint v9+). One block covers both browser and node code,
// since the union of globals is small.
export default [
  {
    // Build / generated artifacts. `docs-site/**` is the TypeDoc
    // output (gitignored too); `spektrum.min.js` is the engine build
    // (`companions/*.min.js` already aren't tracked by ESLint because
    // the build runs after lint in CI).
    ignores: ['node_modules/**', 'spektrum.min.js', 'docs-site/**'],
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
