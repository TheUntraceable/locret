const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require('uniwind/metro');

let config = getDefaultConfig(__dirname);
config = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './src/uniwind-types.d.ts',
  extraThemes: [
    'alpha-light',
    'alpha-dark',
  ],
});

module.exports = config;