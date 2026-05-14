const path = require('path');
const { getDefaultConfig } = require('@react-native/metro-config');

const root = path.resolve(__dirname, '../..');
const defaultConfig = getDefaultConfig(__dirname);

const packages = {
  '@imcsorin/react-native-ota': root,
};

module.exports = {
  ...defaultConfig,

  projectRoot: __dirname,
  watchFolders: [root],

  transformer: {
    ...defaultConfig.transformer,
    babelTransformerPath:
      require.resolve('react-native-svg-transformer/react-native'),
  },

  resolver: {
    ...defaultConfig.resolver,
    assetExts: defaultConfig.resolver.assetExts.filter((ext) => ext !== 'svg'),
    sourceExts: [...defaultConfig.resolver.sourceExts, 'svg'],
    extraNodeModules: {
      'react': path.resolve(__dirname, 'node_modules/react'),
      'react-native': path.resolve(__dirname, 'node_modules/react-native'),
    },
    blockList: [
      new RegExp(
        `^${path.join(root, 'node_modules', 'react').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`
      ),
      new RegExp(
        `^${path.join(root, 'node_modules', 'react-native').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`
      ),
    ],
    resolveRequest: (context, moduleName, platform) => {
      if (Object.keys(packages).some((name) => moduleName.startsWith(name))) {
        context = {
          ...context,
          mainFields: ['source', ...context.mainFields],
          unstable_conditionNames: [
            'source',
            ...context.unstable_conditionNames,
          ],
        };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};
