import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.test-build/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { require: 'readonly', process: 'readonly', console: 'readonly', __dirname: 'readonly', __filename: 'readonly', module: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  }
);
