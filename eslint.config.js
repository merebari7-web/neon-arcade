// Flat config: browser code and node code get different environments.
import globals from 'globals';

const shared = {
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    'no-empty': ['warn', { allowEmptyCatch: true }],
    'no-const-assign': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-self-assign': 'error',
    'no-unreachable': 'error',
    'no-unsafe-negation': 'error',
    'use-isnan': 'error',
    'valid-typeof': 'error',
  },
};

export default [
  { ignores: ['node_modules/**', 'data/**', '.smoke-data/**'] },
  {
    ...shared,
    files: ['public/**/*.js'],
    languageOptions: { ...shared.languageOptions, globals: { ...globals.browser } },
  },
  {
    ...shared,
    files: ['server/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { ...shared.languageOptions, globals: { ...globals.node } },
  },
  {
    // the browser test ships callbacks that run inside the page, so it sees both worlds
    ...shared,
    files: ['tests/visual.test.js'],
    languageOptions: { ...shared.languageOptions, globals: { ...globals.node, ...globals.browser } },
  },
];
