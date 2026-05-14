import archiver from 'archiver';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const DEFAULT_MANIFEST_ROOT = 'manifests';
export const DEFAULT_OUTPUT_DIRECTORY = '.react-native-ota';
export const DEFAULT_UPDATE_ROOT = 'updates';

const IOS_BUNDLE_FILENAME = 'main.jsbundle';
const ANDROID_BUNDLE_FILENAME = 'index.android.bundle';
const ENTRY_FILE_CANDIDATES = ['index.js', 'index.ts', 'index.tsx'];
const METRO_CONFIG_CANDIDATES = [
  'metro.config.js',
  'metro.config.cjs',
  'metro.config.mjs',
  'metro.config.ts',
];
const SUPPORTED_PLATFORMS = ['ios', 'android'];

export async function buildArtifacts({
  bundleVersion,
  entryFile,
  metroConfigPath,
  outputRoot,
  platforms = SUPPORTED_PLATFORMS,
  projectRoot,
  skipBundle = false,
  versions,
}) {
  const selectedPlatforms = normalizePlatforms(platforms);
  const resolvedVersions =
    versions ??
    (await readBinaryVersions({
      platforms: selectedPlatforms,
      projectRoot,
    }));
  const buildRoot = path.join(
    resolveOutputRoot(projectRoot, outputRoot),
    getBundleVersionPathComponent(bundleVersion)
  );
  const stagingRoot = path.join(buildRoot, 'staging');
  const metadataPath = path.join(buildRoot, 'metadata.json');
  const reactNativeCliPath = resolveReactNativeCli(projectRoot);
  const resolvedEntryFile = await resolveEntryFile(projectRoot, entryFile);
  const resolvedMetroConfigPath = await resolveMetroConfigPath(
    projectRoot,
    metroConfigPath
  );
  const artifactPaths = {
    buildRoot,
    bundleDirectoryName: getBundleVersionPathComponent(bundleVersion),
    metadataPath,
    versions: resolvedVersions,
  };

  for (const platform of selectedPlatforms) {
    artifactPaths[platform === 'ios' ? 'iosZip' : 'androidZip'] = path.join(buildRoot, `${platform}.zip`);
  }

  if (skipBundle) {
    return artifactPaths;
  }

  await rm(buildRoot, { force: true, recursive: true });
  await mkdir(stagingRoot, { recursive: true });

  for (const platform of selectedPlatforms) {
    const stagingDir = path.join(stagingRoot, platform);
    const zipPath = artifactPaths[platform === 'ios' ? 'iosZip' : 'androidZip'];

    await mkdir(stagingDir, { recursive: true });
    await buildPlatformBundle({
      bundleOutput: path.join(
        stagingDir,
        platform === 'ios' ? IOS_BUNDLE_FILENAME : ANDROID_BUNDLE_FILENAME
      ),
      entryFile: resolvedEntryFile,
      metroConfigPath: resolvedMetroConfigPath,
      platform,
      projectRoot,
      reactNativeCliPath,
      stagingDir,
    });
    await zipDirectory(stagingDir, zipPath);
  }

  await writeFile(
    metadataPath,
    `${JSON.stringify(buildMetadata(bundleVersion, resolvedVersions), null, 2)}\n`
  );

  return artifactPaths;
}

export function createDefaultBundleVersion() {
  const now = new Date();
  const timestamp =
    now.getFullYear() * 10_000_000_000 +
    (now.getMonth() + 1) * 100_000_000 +
    now.getDate() * 1_000_000 +
    now.getHours() * 10_000 +
    now.getMinutes() * 100 +
    now.getSeconds();

  return timestamp;
}

export function createManifest({
  binaryVersion,
  bundleVersion,
  platform,
  publicUrlBase,
  updateRoot = DEFAULT_UPDATE_ROOT,
}) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported platform "${platform}" for OTA manifest`);
  }

  normalizeManifestBinaryVersion(binaryVersion);
  const normalizedBundleVersion = normalizeBundleVersion(bundleVersion);

  return {
    bundleVersion: normalizedBundleVersion,
    downloadUrl: joinUrlPath(
      publicUrlBase,
      buildUpdateRelativePath({
        bundleVersion: normalizedBundleVersion,
        platform,
        updateRoot,
      })
    ),
  };
}

export function buildManifestRelativePath({
  binaryVersion,
  manifestRoot = DEFAULT_MANIFEST_ROOT,
  platform,
}) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported platform "${platform}" for OTA manifest path`);
  }

  return joinPathSegments(
    trimSlashes(manifestRoot),
    platform,
    `${normalizeManifestBinaryVersion(binaryVersion)}.json`
  );
}

export function getBundleVersionPathComponent(bundleVersion) {
  const sanitized = sanitizePathComponent(String(normalizeBundleVersion(bundleVersion)));

  return sanitized.length > 0 ? sanitized : 'bundle';
}

export function joinUrlPath(baseUrl, relativePath) {
  const normalizedBaseUrl = ensureTrailingSlash(baseUrl);
  const encodedRelativePath = encodeUrlPath(relativePath);

  if (encodedRelativePath.length === 0) {
    return normalizedBaseUrl.endsWith('/')
      ? normalizedBaseUrl.slice(0, -1)
      : normalizedBaseUrl;
  }

  return new URL(encodedRelativePath, normalizedBaseUrl).toString();
}

export function parsePlatformOption(value = 'all') {
  const normalizedValue = value.trim().toLowerCase();

  if (normalizedValue === 'all') {
    return [...SUPPORTED_PLATFORMS];
  }

  const platforms = [...new Set(normalizedValue.split(',').map((part) => part.trim()))]
    .filter(Boolean);

  if (platforms.length === 0) {
    throw new Error(
      'Expected --platform to be one of "all", "ios", "android", or "ios,android"'
    );
  }

  for (const platform of platforms) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(
        `Unsupported platform "${platform}". Expected "ios" and/or "android".`
      );
    }
  }

  return platforms;
}

export async function readBinaryVersions({
  androidBinaryVersion,
  iosBinaryVersion,
  platforms = SUPPORTED_PLATFORMS,
  projectRoot,
}) {
  const selectedPlatforms = normalizePlatforms(platforms);
  const versions = {};

  if (selectedPlatforms.includes('android')) {
    versions.android =
      androidBinaryVersion ?? (await detectAndroidBinaryVersion(projectRoot));
  }

  if (selectedPlatforms.includes('ios')) {
    versions.ios = iosBinaryVersion ?? (await detectIosBinaryVersion(projectRoot));
  }

  return versions;
}

function buildMetadata(bundleVersion, versions) {
  return {
    androidBinaryVersion: versions.android ?? null,
    bundleVersion: normalizeBundleVersion(bundleVersion),
    iosBinaryVersion: versions.ios ?? null,
  };
}

function buildUpdateRelativePath({ bundleVersion, platform, updateRoot }) {
  return joinPathSegments(
    trimSlashes(updateRoot),
    getBundleVersionPathComponent(bundleVersion),
    `${platform}.zip`
  );
}

async function buildPlatformBundle({
  bundleOutput,
  entryFile,
  metroConfigPath,
  platform,
  projectRoot,
  reactNativeCliPath,
  stagingDir,
}) {
  console.log(`[react-native-ota-release] Building ${platform} bundle`);
  const cliArgs = [reactNativeCliPath, 'bundle'];

  if (metroConfigPath != null) {
    cliArgs.push('--config', metroConfigPath);
  }

  cliArgs.push(
    '--entry-file',
    entryFile,
    '--platform',
    platform,
    '--dev',
    'false',
    '--bundle-output',
    bundleOutput,
    '--assets-dest',
    stagingDir
  );

  await runCommand(process.execPath, cliArgs, {
    cwd: projectRoot,
    label: `bundle:${platform}`,
  });

  console.log(`[react-native-ota-release] Built ${platform} bundle`);
}

async function detectAndroidBinaryVersion(projectRoot) {
  const buildGradleCandidates = [
    path.join(projectRoot, 'android/app/build.gradle'),
    path.join(projectRoot, 'android/app/build.gradle.kts'),
  ];

  for (const candidatePath of buildGradleCandidates) {
    const contents = await readTextIfExists(candidatePath);
    const versionName = contents && parseGradleVersionName(contents);

    if (versionName != null) {
      return versionName;
    }
  }

  const gradlePropertiesCandidates = [
    path.join(projectRoot, 'android/gradle.properties'),
    path.join(projectRoot, 'gradle.properties'),
  ];

  for (const candidatePath of gradlePropertiesCandidates) {
    const contents = await readTextIfExists(candidatePath);
    const versionName = contents && parseGradlePropertiesVersionName(contents);

    if (versionName != null) {
      return versionName;
    }
  }

  throw new Error(
    'Failed to detect the Android binary version. Pass --android-binary-version to override it.'
  );
}

async function detectIosBinaryVersion(projectRoot) {
  const xcodeProjectPaths = await findXcodeProjectPaths(projectRoot);

  for (const xcodeProjectPath of xcodeProjectPaths) {
    const contents = await readTextIfExists(xcodeProjectPath);
    const version = contents && parseMarketingVersion(contents);

    if (version != null) {
      return version;
    }
  }

  const infoPlistPaths = await findInfoPlistPaths(projectRoot);

  for (const infoPlistPath of infoPlistPaths) {
    const contents = await readTextIfExists(infoPlistPath);
    const version = contents && parseInfoPlistVersion(contents);

    if (version != null) {
      return version;
    }
  }

  throw new Error(
    'Failed to detect the iOS binary version. Pass --ios-binary-version to override it.'
  );
}

function encodeUrlPath(value) {
  return trimSlashes(value)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function ensureTrailingSlash(value) {
  const normalizedValue = value.endsWith('/') ? value : `${value}/`;

  return new URL(normalizedValue).toString();
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findFilesRecursively(rootDir, predicate, maxDepth = 3) {
  const matches = [];

  async function visit(currentDir, depth) {
    if (depth > maxDepth || !(await fileExists(currentDir))) {
      return;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (shouldIgnoreSearchDirectory(entry.name)) {
          continue;
        }

        await visit(absolutePath, depth + 1);
        continue;
      }

      if (predicate(entry.name, absolutePath)) {
        matches.push(absolutePath);
      }
    }
  }

  await visit(rootDir, 0);

  return matches.sort();
}

async function findInfoPlistPaths(projectRoot) {
  return findFilesRecursively(
    path.join(projectRoot, 'ios'),
    (fileName) => fileName === 'Info.plist'
  );
}

async function findXcodeProjectPaths(projectRoot) {
  const iosDir = path.join(projectRoot, 'ios');

  if (!(await fileExists(iosDir))) {
    return [];
  }

  const entries = await readdir(iosDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj'))
    .map((entry) => path.join(iosDir, entry.name, 'project.pbxproj'))
    .sort();
}

function joinPathSegments(...segments) {
  return segments.map(trimSlashes).filter(Boolean).join('/');
}

function normalizePlatforms(platforms) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    return [...SUPPORTED_PLATFORMS];
  }

  return [...new Set(platforms)];
}

function normalizeManifestBinaryVersion(value) {
  if (typeof value !== 'string') {
    throw new Error('OTA manifest binaryVersion must be a string');
  }

  const normalizedValue = value.trim();

  if (normalizedValue.length === 0) {
    throw new Error('OTA manifest binaryVersion must not be empty');
  }

  if (normalizedValue.includes('/') || normalizedValue.includes('\\')) {
    throw new Error(
      `OTA manifest binaryVersion "${normalizedValue}" must not contain path separators`
    );
  }

  return normalizedValue;
}

export function normalizeBundleVersion(value) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) {
      return value;
    }

    throw new Error(`OTA manifest bundleVersion "${value}" must be a safe integer`);
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim();

    if (!/^\d+$/.test(normalizedValue)) {
      throw new Error(
        `OTA manifest bundleVersion "${normalizedValue}" must be an integer`
      );
    }

    const parsedValue = Number(normalizedValue);

    if (!Number.isSafeInteger(parsedValue)) {
      throw new Error(
        `OTA manifest bundleVersion "${normalizedValue}" must be a safe integer`
      );
    }

    return parsedValue;
  }

  throw new Error('OTA manifest bundleVersion must be an integer');
}

function parseGradlePropertiesVersionName(contents) {
  const versionName = contents.match(/^\s*VERSION_NAME\s*=\s*(.+)\s*$/m)?.[1];

  return normalizeVersionCandidate(versionName);
}

function parseGradleVersionName(contents) {
  const patterns = [
    /versionName\s*=\s*["']([^"']+)["']/,
    /versionName\s+["']([^"']+)["']/,
  ];

  for (const pattern of patterns) {
    const candidate = contents.match(pattern)?.[1];
    const version = normalizeVersionCandidate(candidate);

    if (version != null) {
      return version;
    }
  }

  return null;
}

function parseInfoPlistVersion(contents) {
  const candidate = contents.match(
    /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]+)<\/string>/
  )?.[1];

  return normalizeVersionCandidate(candidate);
}

function parseMarketingVersion(contents) {
  const matches = contents.matchAll(/MARKETING_VERSION = ([^;]+);/g);

  for (const match of matches) {
    const version = normalizeVersionCandidate(match[1]);

    if (version != null) {
      return version;
    }
  }

  return null;
}

async function readTextIfExists(filePath) {
  if (!(await fileExists(filePath))) {
    return null;
  }

  return readFile(filePath, 'utf8');
}

function resolveOutputRoot(projectRoot, outputRoot) {
  if (outputRoot == null) {
    return path.join(projectRoot, DEFAULT_OUTPUT_DIRECTORY);
  }

  return path.isAbsolute(outputRoot)
    ? outputRoot
    : path.resolve(projectRoot, outputRoot);
}

async function resolveEntryFile(projectRoot, entryFile) {
  const candidatePaths = entryFile
    ? [path.isAbsolute(entryFile) ? entryFile : path.resolve(projectRoot, entryFile)]
    : ENTRY_FILE_CANDIDATES.map((candidate) => path.join(projectRoot, candidate));

  for (const candidatePath of candidatePaths) {
    if (await fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  const displayCandidates = candidatePaths.map((candidate) =>
    path.relative(projectRoot, candidate)
  );

  throw new Error(
    `Failed to resolve the React Native entry file. Checked: ${displayCandidates.join(
      ', '
    )}. Pass --entry-file to override it.`
  );
}

async function resolveMetroConfigPath(projectRoot, metroConfigPath) {
  if (metroConfigPath != null) {
    const resolvedPath = path.isAbsolute(metroConfigPath)
      ? metroConfigPath
      : path.resolve(projectRoot, metroConfigPath);

    if (!(await fileExists(resolvedPath))) {
      throw new Error(`Metro config not found at ${resolvedPath}`);
    }

    return resolvedPath;
  }

  for (const candidate of METRO_CONFIG_CANDIDATES) {
    const candidatePath = path.join(projectRoot, candidate);

    if (await fileExists(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

function resolveReactNativeCli(projectRoot) {
  const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));

  try {
    return requireFromProject.resolve('react-native/cli.js');
  } catch {
    throw new Error(
      `Failed to resolve react-native/cli.js from ${projectRoot}. Install react-native in the project root before running the OTA release CLI.`
    );
  }
}

function normalizeVersionCandidate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().replace(/^['"]|['"]$/g, '');

  if (
    normalizedValue.length === 0 ||
    normalizedValue.includes('$(') ||
    normalizedValue.includes('${')
  ) {
    return null;
  }

  return normalizedValue;
}

async function runCommand(command, args, { cwd, label }) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} failed with exit code ${code ?? 'unknown'}`));
    });
  });
}

function sanitizePathComponent(value) {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function shouldIgnoreSearchDirectory(directoryName) {
  return (
    directoryName === 'Pods' ||
    directoryName === 'build' ||
    directoryName === 'DerivedData' ||
    directoryName.startsWith('.')
  );
}

function trimSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '');
}

async function zipDirectory(sourceDir, destinationZip) {
  console.log(`[react-native-ota-release] Packaging ${path.basename(destinationZip)}`);
  await rm(destinationZip, { force: true });
  await mkdir(path.dirname(destinationZip), { recursive: true });

  await new Promise((resolve, reject) => {
    const output = createWriteStream(destinationZip);
    const archive = archiver('zip', {
      zlib: { level: 9 },
    });

    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    void archive.finalize();
  });

  console.log(`[react-native-ota-release] Packaged ${path.basename(destinationZip)}`);
}
