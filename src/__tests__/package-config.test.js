const {
  normalizeOtaPackageConfig,
  readRawOtaConfig,
} = require('../../scripts/ota-package-config');

describe('normalizeOtaPackageConfig', () => {
  it('keeps one shared public URL base', () => {
    expect(
      normalizeOtaPackageConfig({
        publicUrlBase: 'https://example.com/ota',
      })
    ).toEqual({
      publicUrlBase: 'https://example.com/ota',
    });
  });

  it('rejects the removed manifestUrl config and platform-specific overrides', () => {
    expect(() =>
      normalizeOtaPackageConfig({
        manifestUrl: 'https://example.com/ota/manifest.json',
      })
    ).toThrow(
      'react-native-ota.manifestUrl has been removed; use react-native-ota.publicUrlBase'
    );

    expect(() =>
      normalizeOtaPackageConfig({
        android: {
          publicUrlBase: 'https://example.com/ota/android',
        },
      })
    ).toThrow(
      'react-native-ota package.json config does not support platform-specific OTA config'
    );
  });
});

describe('readRawOtaConfig', () => {
  it('supports both package.json config keys', () => {
    expect(
      readRawOtaConfig({
        '@imcsorin/react-native-ota': {
          publicUrlBase: 'https://example.com/ota',
        },
      })
    ).toEqual({
      publicUrlBase: 'https://example.com/ota',
    });
  });
});
