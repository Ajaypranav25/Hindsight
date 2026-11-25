import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'dist',
      'coverage',
      'node_modules',
      'playwright-report',
      'test-results',
      'editors/vscode/dist',
      'desktop/dist',
      'desktop/release',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/studio/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs['recommended-latest'].rules },
    languageOptions: { globals: globals.browser },
  },
  {
    files: [
      'src/cli/**',
      'scripts/**',
      'e2e/**',
      'tests/**',
      '*.config.{js,ts}',
      'editors/vscode/scripts/**',
      'desktop/scripts/**',
      'desktop/e2e/**',
      'desktop/*.{cjs,ts}',
    ],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    // The desktop app's main process and preload script.
    files: ['desktop/src/**'],
    languageOptions: { globals: globals.node },
  },
)
