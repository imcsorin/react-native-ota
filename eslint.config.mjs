import { fixupPluginRules } from '@eslint/compat';
import reactNativeConfig from '@react-native/eslint-config/flat';
import prettier from 'eslint-plugin-prettier';
import { defineConfig } from 'eslint/config';

const compatibleReactNativeConfig = reactNativeConfig.map((config) => {
  if (config.plugins == null) {
    return config;
  }

  return {
    ...config,
    plugins: Object.fromEntries(
      Object.entries(config.plugins).map(([name, plugin]) => [
        name,
        name === 'ft-flow' ? fixupPluginRules(plugin) : plugin,
      ])
    ),
  };
});

export default defineConfig([
  ...compatibleReactNativeConfig,
  {
    files: ['**/*.{js,jsx,ts,tsx,mjs,cjs}'],
    plugins: { prettier },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'prettier/prettier': 'error',
    },
  },
  {
    ignores: [
      'node_modules/',
      'lib/',
      '.ota-test/',
      '.ota-test-cache/',
      'examples/*/.ota-server/',
    ],
  },
]);
