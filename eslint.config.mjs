import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['node_modules/**', 'out/**', 'out-test/**', 'dist/**', 'target/**', '.vscode-test/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['src/**/*.ts'], rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
