#!/usr/bin/env node

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  DEFAULT_UPDATE_ROOT,
  buildManifestRelativePath,
  buildArtifacts,
  createDefaultBundleVersion,
  createManifest,
  getBundleVersionPathComponent,
  joinUrlPath,
  normalizeBundleVersion,
  parsePlatformOption,
  readBinaryVersions,
} from './release-helpers.mjs';

const require = createRequire(import.meta.url);
const { installProject } = require('./cli-install.js');
const { resolveOtaPackageConfig } = require('./ota-package-config.js');

const DEFAULT_COMMAND = 'publish';
const DEFAULT_PLATFORM = 'all';
const DEFAULT_S3_REGION = 'us-east-1';
const BOOLEAN_OPTIONS = new Set(['dryRun', 'skipBundle', 'skipPackageInstall', 'skipPods']);
const REQUIRED_S3_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ENDPOINT',
  'AWS_PATH',
];
const OPTIONAL_S3_ENV_KEYS = [];
const DEPRECATED_S3_FLAGS = {
  accessKeyId: '--access-key-id',
  endpoint: '--endpoint',
  path: '--path',
  publicUrlBase: '--public-url-base',
  region: '--region',
  secretAccessKey: '--secret-access-key',
  sessionToken: '--session-token',
  target: '--target',
};

async function main() {
  try {
    const { command, options } = parseArgs(process.argv.slice(2));

    if (command === 'help') {
      printUsage();
      return;
    }

    if (command === 'install') {
      const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
      const platforms = parsePlatformOption(options.platform ?? DEFAULT_PLATFORM);
      const installResult = await installProject({
        packageManager: options.packageManager,
        packageName: '@imcsorin/react-native-ota',
        platforms,
        publicUrlBase: options.publicUrlBase,
        projectRoot,
        skipPackageInstall: options.skipPackageInstall === true,
        skipPods: options.skipPods === true,
      });

      console.log(
        JSON.stringify(
          {
            command,
            ...installResult,
          },
          null,
          2
        )
      );
      return;
    }

    if (command !== DEFAULT_COMMAND) {
      throw new Error(
        `Unsupported command "${command}". Expected "${DEFAULT_COMMAND}" or "install".`
      );
    }

    const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    assertUnsupportedS3Flags(options);
    const s3Environment = resolveRequiredS3Environment(process.env);
    const bundleVersion = normalizeBundleVersion(
      options.bundleVersion ?? createDefaultBundleVersion()
    );
    const platforms = parsePlatformOption(options.platform ?? DEFAULT_PLATFORM);
    const target = parseUploadPath(s3Environment.path);
    const dryRun = options.dryRun === true;
    const versions = await readBinaryVersions({
      androidBinaryVersion: options.androidBinaryVersion,
      iosBinaryVersion: options.iosBinaryVersion,
      platforms,
      projectRoot,
    });
    const artifacts = await buildArtifacts({
      bundleVersion,
      entryFile: options.entryFile,
      metroConfigPath: options.metroConfig,
      outputRoot: options.outputDir,
      platforms,
      projectRoot,
      skipBundle: options.skipBundle === true,
      versions,
    });
    const { packageJsonPath, publicUrlBase } = resolveProjectPublicUrlBase(
      projectRoot
    );
    const manifests = buildManifestSummaries({
      bundleVersion,
      platforms,
      publicUrlBase,
      versions,
    });
    const uploadPlan = buildUploadPlan({
      bundleVersion,
      manifests,
      platforms,
      prefix: target.prefix,
    });
    const clientConfig = createS3ClientConfig(s3Environment);
    const client = new S3Client(clientConfig);
    const uploadSummary = dryRun
      ? { dryRun: true, uploaded: false }
      : await uploadArtifacts({
            artifacts,
            bucket: target.bucket,
            client,
            manifestKeys: uploadPlan.manifestKeys,
            manifests,
            platformKeys: uploadPlan.platformKeys,
          });

    console.log(
      JSON.stringify(
        {
          bucket: target.bucket,
          bundleVersion,
          dryRun,
          localArtifacts: {
            androidZip: artifacts.androidZip ?? null,
            buildRoot: artifacts.buildRoot,
            iosZip: artifacts.iosZip ?? null,
            metadataPath: artifacts.metadataPath,
          },
          manifests: buildManifestOutput({
            manifestKeys: uploadPlan.manifestKeys,
            manifests,
          }),
          packageJsonPath,
          publicUrlBase,
          platformUrls: buildPlatformUrls({
            bundleVersion,
            platforms,
            publicUrlBase,
          }),
          prefix: target.prefix || null,
          projectRoot,
          endpoint: s3Environment.endpoint,
          s3CredentialsSource: 'environment-variables',
          upload: {
            ...uploadSummary,
            plannedKeys: {
              android: uploadPlan.platformKeys.android ?? null,
              ios: uploadPlan.platformKeys.ios ?? null,
              manifests: {
                android: uploadPlan.manifestKeys.android ?? null,
                ios: uploadPlan.manifestKeys.ios ?? null,
              },
            },
          },
          versions,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Unknown OTA release failure'
    );
    process.exitCode = 1;
  }
}

function buildPlatformUrls({ bundleVersion, platforms, publicUrlBase }) {
  const urls = {};
  const bundleDirectoryName = getBundleVersionPathComponent(bundleVersion);

  if (platforms.includes('android')) {
    urls.android = joinUrlPath(
      publicUrlBase,
      `${DEFAULT_UPDATE_ROOT}/${bundleDirectoryName}/android.zip`
    );
  }

  if (platforms.includes('ios')) {
    urls.ios = joinUrlPath(
      publicUrlBase,
      `${DEFAULT_UPDATE_ROOT}/${bundleDirectoryName}/ios.zip`
    );
  }

  return urls;
}

function buildManifestOutput({ manifestKeys, manifests }) {
  return Object.fromEntries(
    Object.entries(manifests).map(([platform, manifest]) => [
      platform,
      {
        key: manifestKeys[platform] ?? null,
        payload: manifest.payload,
        url: manifest.url,
      },
    ])
  );
}

function buildManifestSummaries({ bundleVersion, platforms, publicUrlBase, versions }) {
  const manifests = {};

  for (const platform of platforms) {
    const payload = createManifest({
      binaryVersion: versions[platform],
      bundleVersion,
      platform,
      publicUrlBase,
    });

    manifests[platform] = {
      binaryVersion: versions[platform],
      payload,
      url: joinUrlPath(
        publicUrlBase,
        buildManifestRelativePath({
          binaryVersion: versions[platform],
          platform,
        })
      ),
    };
  }

  return manifests;
}

function buildUploadPlan({ bundleVersion, manifests, platforms, prefix }) {
  const bundleDirectoryName = getBundleVersionPathComponent(bundleVersion);
  const manifestKeys = {};
  const platformKeys = {};

  if (platforms.includes('android')) {
    manifestKeys.android = joinObjectKey(
      prefix,
      buildManifestRelativePath({
        binaryVersion: manifests.android.binaryVersion,
        platform: 'android',
      })
    );
    platformKeys.android = joinObjectKey(
      prefix,
      `${DEFAULT_UPDATE_ROOT}/${bundleDirectoryName}/android.zip`
    );
  }

  if (platforms.includes('ios')) {
    manifestKeys.ios = joinObjectKey(
      prefix,
      buildManifestRelativePath({
        binaryVersion: manifests.ios.binaryVersion,
        platform: 'ios',
      })
    );
    platformKeys.ios = joinObjectKey(
      prefix,
      `${DEFAULT_UPDATE_ROOT}/${bundleDirectoryName}/ios.zip`
    );
  }

  return {
    manifestKeys,
    platformKeys,
  };
}

function assertUnsupportedS3Flags(options) {
  const usedFlags = Object.entries(DEPRECATED_S3_FLAGS)
    .filter(([optionName]) => optionName in options)
    .map(([, flagName]) => flagName);

  if (usedFlags.length === 0) {
    return;
  }

  throw new Error(
    `Publish upload configuration now comes from environment variables and package.json. Remove ${usedFlags.join(
      ', '
    )}, keep ${[
      ...REQUIRED_S3_ENV_KEYS,
      ...OPTIONAL_S3_ENV_KEYS,
    ].join(', ')} for uploads, and configure react-native-ota.publicUrlBase in your app package.json.`
  );
}

function createS3ClientConfig(environment) {
  return {
    credentials: {
      accessKeyId: environment.accessKeyId,
      secretAccessKey: environment.secretAccessKey,
    },
    endpoint: environment.endpoint,
    forcePathStyle: true,
    region: DEFAULT_S3_REGION,
  };
}

function joinObjectKey(prefix, relativePath) {
  return [prefix, relativePath].filter(Boolean).join('/');
}

function normalizeOptionName(value) {
  return value.replace(/-([a-z])/g, (_match, character) =>
    character.toUpperCase()
  );
}

function parseArgs(argv) {
  const firstArgument = argv[0];

  if (firstArgument === 'help' || firstArgument === '--help' || firstArgument === '-h') {
    return {
      command: 'help',
      options: {},
    };
  }

  const command =
    firstArgument == null || firstArgument.startsWith('--')
      ? DEFAULT_COMMAND
      : firstArgument;
  const flags =
    firstArgument == null || firstArgument.startsWith('--') ? argv : argv.slice(1);
  const options = {};

  for (let index = 0; index < flags.length; index += 1) {
    const current = flags[index];

    if (current === '--help' || current === '-h') {
      return {
        command: 'help',
        options: {},
      };
    }

    if (!current.startsWith('--')) {
      throw new Error(`Unexpected argument "${current}"`);
    }

    const optionName = normalizeOptionName(current.slice(2));

    if (BOOLEAN_OPTIONS.has(optionName)) {
      options[optionName] = true;
      continue;
    }

    const optionValue = flags[index + 1];

    if (optionValue == null || optionValue.startsWith('--')) {
      throw new Error(`Missing value for --${current.slice(2)}`);
    }

    options[optionName] = optionValue;
    index += 1;
  }

  return {
    command,
    options,
  };
}

function parseUploadPath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      'Missing AWS_PATH. Expected a bucket path such as my-bucket/mobile/prod.'
    );
  }

  const normalizedValue = value.replace(/^\/+|\/+$/g, '');
  const [bucket, ...prefixSegments] = normalizedValue.split('/').filter(Boolean);

  if (bucket == null || bucket.length === 0) {
    throw new Error(`Invalid AWS_PATH "${value}". Expected bucket/prefix or bucket.`);
  }

  return {
    bucket,
    prefix: prefixSegments.join('/'),
  };
}

function printUsage() {
  console.log(`react-native-ota-release <publish|install> [options]

Install command:
  react-native-ota-release install [options]

Install options:
  --project-root <path>
  --platform <all|ios|android|ios,android>
  --public-url-base <https://cdn.example.com/mobile/prod>
  --package-manager <npm|yarn|pnpm|bun>
  --skip-package-install
  --skip-pods

Required environment variables:
  AWS_ACCESS_KEY_ID=<aws-access-key-id>
  AWS_SECRET_ACCESS_KEY=<aws-secret-access-key>
  AWS_ENDPOINT=<https://s3.example.com>
  AWS_PATH=<bucket/prefix>

Build options:
  --bundle-version <integer>
  --platform <all|ios|android|ios,android>
  --project-root <path>
  --entry-file <index.js>
  --metro-config <metro.config.js>
  --ios-binary-version <value>
  --android-binary-version <value>
  --output-dir <path>
  --dry-run

Behavior:
  The command fails fast if any required upload environment variable is missing.
  Public manifest/download URLs come from react-native-ota.publicUrlBase in your app package.json.

Examples:
  react-native-ota-release install \\
    --public-url-base https://cdn.example.com/mobile/prod

  react-native-ota-release install \\
    --platform android \\
    --skip-package-install

  AWS_ACCESS_KEY_ID=<aws-access-key-id> \\
  AWS_SECRET_ACCESS_KEY=<aws-secret-access-key> \\
  AWS_ENDPOINT=https://s3.example.com \\
  AWS_PATH=my-bucket/mobile/prod \\
  react-native-ota-release publish \\
    --bundle-version 1024

  AWS_ACCESS_KEY_ID=<aws-access-key-id> \\
  AWS_SECRET_ACCESS_KEY=<aws-secret-access-key> \\
  AWS_ENDPOINT=https://s3.example.com \\
  AWS_PATH=my-bucket/mobile/prod \\
  react-native-ota-release publish
`);
}

function resolveRequiredS3Environment(environment) {
  const normalizedEnvironment = {
    accessKeyId: normalizeEnvironmentValue(environment.AWS_ACCESS_KEY_ID),
    endpoint: normalizeEnvironmentValue(environment.AWS_ENDPOINT),
    path: normalizeEnvironmentValue(environment.AWS_PATH),
    secretAccessKey: normalizeEnvironmentValue(environment.AWS_SECRET_ACCESS_KEY),
  };
  const missingKeys = REQUIRED_S3_ENV_KEYS.filter((key) => {
    switch (key) {
      case 'AWS_ACCESS_KEY_ID':
        return normalizedEnvironment.accessKeyId == null;
      case 'AWS_ENDPOINT':
        return normalizedEnvironment.endpoint == null;
      case 'AWS_PATH':
        return normalizedEnvironment.path == null;
      case 'AWS_SECRET_ACCESS_KEY':
        return normalizedEnvironment.secretAccessKey == null;
      default:
        return false;
    }
  });

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingKeys.join(
        ', '
      )}. Run react-native-ota-release --help for the expected S3 environment contract.`
    );
  }

  return {
    accessKeyId: normalizedEnvironment.accessKeyId,
    endpoint: normalizedEnvironment.endpoint,
    path: normalizedEnvironment.path,
    secretAccessKey: normalizedEnvironment.secretAccessKey,
  };
}

function normalizeEnvironmentValue(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim();

  return normalizedValue.length > 0 ? normalizedValue : null;
}

async function uploadArtifacts({
  artifacts,
  bucket,
  client,
  manifestKeys,
  manifests,
  platformKeys,
}) {
  const uploads = {
    uploaded: true,
  };

  if (platformKeys.android != null) {
    await uploadFile({
      bucket,
      client,
      contentType: 'application/zip',
      filePath: artifacts.androidZip,
      key: platformKeys.android,
    });
  }

  if (platformKeys.ios != null) {
    await uploadFile({
      bucket,
      client,
      contentType: 'application/zip',
      filePath: artifacts.iosZip,
      key: platformKeys.ios,
    });
  }

  for (const [platform, manifest] of Object.entries(manifests)) {
    await uploadJson({
      bucket,
      client,
      key: manifestKeys[platform],
      payload: manifest.payload,
    });
  }

  return uploads;
}

function resolveProjectPublicUrlBase(projectRoot) {
  const { normalizedConfig, packageJsonPath } = resolveOtaPackageConfig(projectRoot);
  const publicUrlBase = normalizedConfig.publicUrlBase;

  if (typeof publicUrlBase === 'string' && publicUrlBase.length > 0) {
    return {
      packageJsonPath,
      publicUrlBase,
    };
  }

  if (packageJsonPath == null) {
    throw new Error(
      `Could not find package.json from ${projectRoot} to resolve react-native-ota.publicUrlBase.`
    );
  }

  throw new Error(
    `Missing react-native-ota.publicUrlBase in ${packageJsonPath}. Run react-native-ota-release install --public-url-base <url> or update package.json directly.`
  );
}

async function uploadFile({ bucket, client, contentType, filePath, key }) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error(`Missing local artifact for ${key}`);
  }

  const fileStats = await stat(filePath);
  const body = await readFile(filePath);

  await client.send(
    new PutObjectCommand({
      Body: body,
      Bucket: bucket,
      ContentLength: fileStats.size,
      ContentType: contentType,
      Key: key,
    })
  );
}

async function uploadJson({ bucket, client, key, payload }) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;

  await client.send(
    new PutObjectCommand({
      Body: body,
      Bucket: bucket,
      ContentLength: Buffer.byteLength(body),
      ContentType: 'application/json; charset=utf-8',
      Key: key,
    })
  );
}

await main();
