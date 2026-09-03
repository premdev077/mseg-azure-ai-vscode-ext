import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/**
 * Standards that are not enforced decay, so the rules that matter are errors
 * rather than warnings — a warning nobody reads is a rule nobody follows.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'media/**',
      'node_modules/**',
      '*.config.*',
      'esbuild.js',
      '.dependency-cruiser.cjs'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // --- extension host ------------------------------------------------------
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json' }
    },
    rules: {
      // The webview standard does not govern the extension host, which predates
      // it. Surfaced so the debt is visible, not blocking so it is not a
      // drive-by refactor of working code.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart']
    }
  },

  // --- webview -------------------------------------------------------------
  {
    files: ['webview/src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { project: './webview/tsconfig.json' },
      globals: { window: 'readonly', document: 'readonly', console: 'readonly' }
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,

      // A missing dependency is a stale-closure bug waiting to happen.
      'react-hooks/exhaustive-deps': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],

      // Features never import each other; shared code is promoted instead.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/features/*/*', '**/features/*/*/**'],
              message:
                'Do not import across features. Promote shared code to components/, hooks/ or utils/.'
            }
          ]
        }
      ],

      // The webview holds no secrets and makes no network calls of its own.
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Route network calls through the extension host.' },
        {
          name: 'localStorage',
          message: 'Use services/persistence (vscode.setState).'
        },
        {
          name: 'sessionStorage',
          message: 'Use services/persistence (vscode.setState).'
        }
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='acquireVsCodeApi']",
          message: 'acquireVsCodeApi belongs in services/vscode.ts only.'
        },
        {
          // Components use `host`; only services touch the raw transport.
          selector: 'ImportSpecifier[imported.name=/^(getVSCodeApi|setVSCodeApi)$/]',
          message: 'Use { host } from services/vscode; the transport is service-only.'
        }
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'smart']
    }
  },

  // The logger is the one place console is the implementation.
  {
    files: ['webview/src/services/logger.ts'],
    rules: { 'no-console': 'off' }
  },
  // Only the transport module may acquire the API.
  {
    files: ['webview/src/services/*.ts'],
    rules: { 'no-restricted-syntax': 'off' }
  },
  // Tests reach into internals deliberately.
  {
    files: ['src/test/**/*.ts', 'webview/src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off'
    }
  }
);
