const fs = require('fs');
const path = require('path');

const OTA_CONFIG_KEYS = ['react-native-ota', '@imcsorin/react-native-ota'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUrlValue(value, label) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  const trimmedValue = value.trim();
  return trimmedValue === '' ? null : trimmedValue;
}

function normalizeOtaPackageConfig(rawConfig) {
  if (rawConfig == null) {
    return {};
  }

  if (!isPlainObject(rawConfig)) {
    throw new Error('react-native-ota package.json config must be an object');
  }

  if ('ios' in rawConfig) {
    throw new Error(
      'react-native-ota package.json config does not support platform-specific OTA config'
    );
  }

  if ('android' in rawConfig) {
    throw new Error(
      'react-native-ota package.json config does not support platform-specific OTA config'
    );
  }

  if ('manifestUrl' in rawConfig) {
    throw new Error(
      'react-native-ota.manifestUrl has been removed; use react-native-ota.publicUrlBase'
    );
  }

  if (
    'publicUrlBase' in rawConfig &&
    rawConfig.publicUrlBase != null &&
    typeof rawConfig.publicUrlBase !== 'string'
  ) {
    throw new Error('react-native-ota.publicUrlBase must be a string');
  }

  const publicUrlBase = normalizeUrlValue(
    rawConfig.publicUrlBase,
    'react-native-ota.publicUrlBase'
  );

  return {
    ...(publicUrlBase ? { publicUrlBase } : {}),
  };
}

function findNearestPackageJson(startPath) {
  let currentPath = path.resolve(startPath);

  while (true) {
    const candidatePath = path.join(currentPath, 'package.json');

    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }

    const parentPath = path.dirname(currentPath);

    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readRawOtaConfig(packageJson) {
  for (const key of OTA_CONFIG_KEYS) {
    if (key in packageJson) {
      return packageJson[key];
    }
  }

  return null;
}

function resolveOtaPackageConfig(searchStart) {
  const packageJsonPath = findNearestPackageJson(searchStart);

  if (!packageJsonPath) {
    return {
      normalizedConfig: {},
      packageJsonPath: null,
    };
  }

  const packageJson = readJsonFile(packageJsonPath);
  const rawConfig = readRawOtaConfig(packageJson);

  return {
    normalizedConfig: normalizeOtaPackageConfig(rawConfig),
    packageJsonPath,
  };
}

module.exports = {
  findNearestPackageJson,
  normalizeOtaPackageConfig,
  readRawOtaConfig,
  resolveOtaPackageConfig,
};
