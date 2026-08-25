import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import moneyPlugin from './eslint-rules/no-number-on-money.js'

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      money: moneyPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // T1.6 / WA-N4. Error, not warn: "review discipline alone will not survive
      // contact with deadlines" (design.md section 7).
      'money/no-number-on-money': 'error',

      // WA-N3 — attacker-controlled token names and symbols are rendered as text.
      'react/no-danger': 'off', // react plugin not installed; enforced by the ban below
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message:
            'dangerouslySetInnerHTML is banned. Token names, symbols and images are attacker-controlled ' +
            'input (WA-N3) and must be rendered as text.',
        },
        {
          selector: "CallExpression[callee.property.name='eval']",
          message: 'eval is banned by the CSP (WA-N2) and would fail at runtime anyway.',
        },
      ],
    },
  },
)
