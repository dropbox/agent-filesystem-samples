// ESLint for FolderSync. Prettier does the formatting.
import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import packageJson from 'eslint-plugin-package-json';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {ignores: ['dist/', 'out/', 'node_modules/']},
  js.configs.recommended,
  tseslint.configs.recommended,
  {files: ['*.mjs', '*.mts', 'scripts/**/*.mjs'], languageOptions: {globals: globals.node}},
  {files: ['src/renderer/**/*.ts'], languageOptions: {globals: globals.browser}},
  packageJson.configs.recommended
);
