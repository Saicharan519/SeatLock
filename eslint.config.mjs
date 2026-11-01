import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', 'frontend', 'packages/db/migrations'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
    languageOptions: { globals: { module: 'writable', require: 'readonly' } },
  },
  {
    // k6 scripts run in k6's own JavaScript runtime, which provides these globals
    files: ['tests/k6/**/*.js'],
    languageOptions: {
      globals: {
        __VU: 'readonly',
        __ITER: 'readonly',
        __ENV: 'readonly',
        open: 'readonly',
        console: 'readonly',
      },
    },
  },
);
