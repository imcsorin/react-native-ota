// TestContext — the central object that every test receives.
//
// It owns the full lifecycle of an e2e test run:
//   1. setup()   — compile apps, start the OTA server, boot simulators/emulators
//   2. run each test in order, collecting pass/fail results
//   3. cleanup() — stop the server, restore modified files
//
// Individual test files (e2e/tests/*.mjs) receive a TestContext instance and
// call methods on it to publish bundles, reinstall the app, launch it, and
// read back the UI state or device logs to make assertions.

import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBinaryVersions } from '../src/cli/release-helpers.mjs';
import { parseUiAssertions } from './assertions.mjs';
import { OtaTestServer } from './server.mjs';
import {
  findJavaHome,
  formatError,
  runCommand,
  sleep,
  startDetachedProcess,
} from './utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// The example app lives under examples/<rn-version>/ in the repo.
const exampleDir = path.join(repoRoot, 'examples/0.85');
const packageJsonPath = path.join(exampleDir, 'package.json');

// All test-generated files (built bundles, generated entry files, S3 storage)
// land under .ota-test/ at the repo root so nothing is written into examples/.
const otaTestRoot = path.join(repoRoot, '.ota-test');
const otaTestCacheRoot = path.join(repoRoot, '.ota-test-cache');
const otaBucket = 'ota-test';

// The release CLI binary we're testing.
const cliBin = path.join(repoRoot, 'bin', 'react-native-ota-release.mjs');

// iOS bundle ID of the example app — used with xcrun simctl and adb commands
// to identify the app on the device.
const bundleId = 'imcsorin.reactnativeota.example';

// The set of named releases that tests can publish.
// bundleVersion is embedded in the OTA manifest; the app uses it to decide
// whether a new bundle is newer than what it currently has.
// scenario controls what code the generated entry file runs:
//   'good'  → registers the app normally (users see the OTA bundle)
//   'crash' → throws an error on startup (triggers the rollback flow)
const releaseConfigs = new Map([
  ['good-2048', { bundleVersion: 2048, scenario: 'good' }],
  ['good-1024', { bundleVersion: 1024, scenario: 'good' }],
  ['bad-4096', { bundleVersion: 4096, scenario: 'crash' }],
]);

// Android log line written at the end of every OTA check cycle (applied,
// skipped, or no-op). Used as a polling sentinel for launchAndroidAndReadUi.
const ANDROID_OTA_SETTLED_LOG = 'Persisted OTA state';

const commonBuildFingerprintInputs = [
  'package.json',
  'yarn.lock',
  'ReactNativeOta.podspec',
  'scripts/generate-ota-config.js',
  'scripts/ota-package-config.js',
  'src/cli/generate-ota-config.js',
  'src/cli/ota-package-config.js',
  'src/library',
  'cpp',
];

const androidBuildFingerprintInputs = [
  ...commonBuildFingerprintInputs,
  'android',
  'examples/0.85/package.json',
  'examples/0.85/app.json',
  'examples/0.85/android',
];

const iosBuildFingerprintInputs = [
  ...commonBuildFingerprintInputs,
  'ios',
  'examples/0.85/package.json',
  'examples/0.85/app.json',
  'examples/0.85/ios',
];

const ignoredFingerprintDirectories = new Set([
  '.gradle',
  'build',
  'DerivedData',
  'Pods',
  'node_modules',
  'xcuserdata',
]);
const maxBuildProgressLineLength = 140;

export class TestContext {
  // hostIp        — IP address the devices use to reach the OTA server
  // platforms     — array of platforms to test, e.g. ['ios', 'android']
  // port          — TCP port for the local OTA server
  // selectedTests — array of test definition objects to run
  // skipBuild     — skip native app compilation (reuse previous build artifacts)
  constructor({ hostIp, platforms, port, selectedTests, skipBuild = false }) {
    this.hostIp = hostIp;
    this.platforms = platforms;
    this.port = port;
    this.skipBuild = skipBuild;
    this.runId = `${Date.now()}-${process.pid}`;
    this.runRoot = path.join(otaTestRoot, this.runId);
    this.iosDerivedDataPath = path.join(otaTestCacheRoot, 'ios', 'DerivedData');

    // The base URL that the app will use to fetch OTA manifests and bundles.
    // It points at our local test server instead of a real CDN.
    this.publicUrlBase = `http://${hostIp}:${port}/${otaBucket}`;

    this.selectedTests = selectedTests;

    // Populated during setup() by reading the binary version from the compiled app.
    this.binaryVersions = null;

    // Tracks whether we already started the Android emulator so we don't start it twice.
    this.androidEmulatorStarted = false;

    // UDID of the iOS simulator we picked; null until ensureIosSimulatorReady() runs.
    this.iosDeviceId = null;

    // Serial of the Android device/emulator; null until ensureAndroidDeviceReady() runs.
    this.androidDeviceId = null;

    // Original contents of examples/0.85/package.json, saved before we overwrite the
    // publicUrlBase field. Restored in cleanup() so the working tree stays clean.
    this.packageJsonBackup = null;

    this.server = new OtaTestServer({
      onLog: (message) => this.log(message),
      port,
      storageRoot: path.join(this.runRoot, '.ota-s3'),
    });
  }

  // Runs setup, executes each test, runs cleanup, and returns an exit code.
  // Exit code 0 means all tests passed; 1 means at least one failed.
  // Even if a test throws, cleanup() always runs (the try/finally ensures it).
  async run() {
    let failureCount = 0;

    try {
      await this.setup();

      for (const test of this.selectedTests) {
        this.logSection(`TEST ${test.id}: ${test.title}`);

        try {
          await test.run(this);
          this.log(`[pass] ${test.id}`);
        } catch (error) {
          failureCount += 1;
          this.log(`[fail] ${test.id}: ${formatError(error)}`);
        }
      }
    } finally {
      await this.cleanup();
    }

    this.logSection('SUMMARY');
    this.log(
      failureCount === 0
        ? `All ${this.selectedTests.length} test(s) passed`
        : `${failureCount} of ${this.selectedTests.length} test(s) failed`
    );

    return failureCount === 0 ? 0 : 1;
  }

  // Prepares everything that needs to be in place before any test runs:
  //   - reads the binary version embedded in the compiled app (needed by some tests)
  //   - patches examples/0.85/package.json so the app talks to our local server
  //   - wipes and recreates the .ota-test scratch directory
  //   - starts the local OTA server
  //   - builds the release app and boots the simulator/emulator for each platform
  async setup() {
    this.logSection('SETUP');

    // Read the binary version that the compiled app reports (e.g. "1.0").
    // Some tests publish a bundle with a different binary version to verify
    // the app ignores it.
    this.binaryVersions = await readBinaryVersions({
      platforms: ['ios', 'android'],
      projectRoot: exampleDir,
    });

    // Back up package.json before we modify it so cleanup() can restore it.
    this.packageJsonBackup = await readFile(packageJsonPath, 'utf8');
    await this.setPackageJsonPublicUrlBase(this.publicUrlBase);

    // Start fresh: delete any leftovers from a previous run, then recreate the directory.
    await rm(this.runRoot, { force: true, recursive: true });
    await mkdir(this.runRoot, { recursive: true });

    await this.server.start();

    // Boot simulators/emulators and build apps in parallel for all requested platforms.
    await Promise.all(
      [
        this.platforms.includes('ios') ? this.setupIosPlatform() : null,
        this.platforms.includes('android') ? this.setupAndroidPlatform() : null,
      ].filter(Boolean)
    );
  }

  async setupIosPlatform() {
    await this.ensureIosSimulatorReady();
    await this.disableIosAnimations();
    if (!this.skipBuild) {
      await this.buildIosReleaseAppIfNeeded();
    }
  }

  async setupAndroidPlatform() {
    await this.ensureAndroidDeviceReady();
    await this.disableAndroidAnimations();
    if (!this.skipBuild) {
      await this.buildAndroidReleaseAppIfNeeded();
    }
  }

  // Tears down resources created during setup:
  //   - stops the OTA server
  //   - restores examples/0.85/package.json to its original content
  async cleanup() {
    this.logSection('CLEANUP');

    await this.server.stop();

    // Only restore if we actually saved a backup — if setup() failed early
    // before the backup was taken, there is nothing to restore.
    if (this.packageJsonBackup != null) {
      await writeFile(packageJsonPath, this.packageJsonBackup);
    }

    await rm(this.runRoot, { force: true, recursive: true });
  }

  // Prefixes every log line with "[ota:test]" so it's easy to spot in the
  // terminal output, which also contains the OTA server's own logs.
  log(message) {
    console.log(`[ota:test] ${message}`);
  }

  // Prints a visual separator before each major phase (SETUP, TEST …, CLEANUP, SUMMARY).
  logSection(title) {
    console.log(`\n[ota:test] ==== ${title} ====`);
  }

  logBuildProgress(prefix, line) {
    const message = `[ota:test] ${prefix}: ${truncateText(line, maxBuildProgressLineLength)}`;

    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(message);
      return;
    }

    process.stdout.write(`\r${message}`);
  }

  finishBuildProgress() {
    if (!process.stdout.isTTY) {
      process.stdout.write('\n');
      return;
    }

    process.stdout.write('\n');
  }

  // Compiles the iOS example app in Release mode.
  // The resulting .app bundle is placed at the path returned by getIosAppPath().
  async buildIosReleaseAppIfNeeded() {
    const fingerprint = await this.createBuildFingerprint({
      env: {
        RCT_NEW_ARCH_ENABLED: process.env.RCT_NEW_ARCH_ENABLED ?? '',
        RCT_REMOVE_LEGACY_ARCH: process.env.RCT_REMOVE_LEGACY_ARCH ?? '',
        RCT_USE_PREBUILT_RNCORE: process.env.RCT_USE_PREBUILT_RNCORE ?? '',
        RCT_USE_RN_DEP: process.env.RCT_USE_RN_DEP ?? '',
      },
      inputs: iosBuildFingerprintInputs,
      platform: 'ios',
    });

    if (
      await this.canReuseNativeBuild('ios', fingerprint, this.getIosAppPath())
    ) {
      this.log('Reusing cached iOS release app');
      return;
    }

    await this.buildIosReleaseApp();
    await this.writeBuildFingerprint('ios', fingerprint);
  }

  async buildIosReleaseApp() {
    const progressPrefix = 'Building iOS release app';
    this.log(progressPrefix);
    await mkdir(this.iosDerivedDataPath, { recursive: true });
    try {
      await runCommand(
        'xcodebuild',
        [
          '-workspace',
          'ios/ReactNativeOtaExample.xcworkspace',
          '-scheme',
          'ReactNativeOtaExample',
          '-configuration',
          'Release',
          '-destination',
          'generic/platform=iOS Simulator',
          '-derivedDataPath',
          this.iosDerivedDataPath,
          'CODE_SIGNING_ALLOWED=NO',
          'CODE_SIGNING_REQUIRED=NO',
          'build',
        ],
        {
          cwd: exampleDir,
          onOutputLine: (line) => this.logBuildProgress(progressPrefix, line),
        }
      );
    } finally {
      this.finishBuildProgress();
    }
  }

  // Compiles the Android example app in Release mode.
  // The resulting APK is placed at the path returned by getAndroidApkPath().
  async buildAndroidReleaseAppIfNeeded() {
    const javaHome = await findJavaHome();

    if (javaHome == null) {
      throw new Error(
        [
          'Android release build requires a JDK, but no usable JAVA_HOME was found.',
          'Install OpenJDK and/or export JAVA_HOME before running yarn ota:test.',
        ].join(' ')
      );
    }

    const fingerprint = await this.createBuildFingerprint({
      env: {
        JAVA_HOME: javaHome,
        ORG_GRADLE_PROJECT_newArchEnabled:
          process.env.ORG_GRADLE_PROJECT_newArchEnabled ?? '',
        reactNativeArchitectures: 'arm64-v8a',
      },
      inputs: androidBuildFingerprintInputs,
      platform: 'android',
    });

    if (
      await this.canReuseNativeBuild(
        'android',
        fingerprint,
        this.getAndroidApkPath()
      )
    ) {
      this.log('Reusing cached Android release app');
      return;
    }

    await this.buildAndroidReleaseApp(javaHome);
    await this.cacheAndroidReleaseApp();
    await this.writeBuildFingerprint('android', fingerprint);
  }

  async buildAndroidReleaseApp(javaHome = null) {
    const progressPrefix = 'Building Android release app';
    this.log(progressPrefix);
    javaHome ??= await findJavaHome();

    if (javaHome == null) {
      throw new Error(
        [
          'Android release build requires a JDK, but no usable JAVA_HOME was found.',
          'Install OpenJDK and/or export JAVA_HOME before running yarn ota:test.',
        ].join(' ')
      );
    }

    try {
      await runCommand('yarn', ['example', 'build:android'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          JAVA_HOME: javaHome,
          PATH: `${path.join(javaHome, 'bin')}:${process.env.PATH ?? ''}`,
        },
        onOutputLine: (line) => this.logBuildProgress(progressPrefix, line),
      });
    } finally {
      this.finishBuildProgress();
    }
  }

  getBuildFingerprintPath(platform) {
    return path.join(otaTestCacheRoot, platform, 'build-fingerprint.json');
  }

  async canReuseNativeBuild(platform, fingerprint, artifactPath) {
    const [artifactExists, cachedFingerprint] = await Promise.all([
      stat(artifactPath).then(
        () => true,
        () => false
      ),
      readFile(this.getBuildFingerprintPath(platform), 'utf8')
        .then((contents) => JSON.parse(contents))
        .catch(() => null),
    ]);

    return artifactExists && cachedFingerprint?.hash === fingerprint.hash;
  }

  async writeBuildFingerprint(platform, fingerprint) {
    const fingerprintPath = this.getBuildFingerprintPath(platform);
    await mkdir(path.dirname(fingerprintPath), { recursive: true });
    await writeFile(
      fingerprintPath,
      `${JSON.stringify(fingerprint, null, 2)}\n`
    );
  }

  async createBuildFingerprint({ env, inputs, platform }) {
    const hash = createHash('sha256');
    hash.update(
      JSON.stringify({
        env,
        platform,
        publicUrlBase: this.publicUrlBase,
        version: 1,
      })
    );

    for (const input of inputs) {
      await this.addPathToHash(hash, path.join(repoRoot, input));
    }

    return {
      createdAt: new Date().toISOString(),
      hash: hash.digest('hex'),
      platform,
    };
  }

  async addPathToHash(hash, filePath) {
    let fileStat;

    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        hash.update(`missing:${path.relative(repoRoot, filePath)}\n`);
        return;
      }

      throw error;
    }

    const relativePath = path.relative(repoRoot, filePath);
    hash.update(`${fileStat.isDirectory() ? 'dir' : 'file'}:${relativePath}\n`);

    if (!fileStat.isDirectory()) {
      hash.update(await readFile(filePath));
      return;
    }

    const entries = await readdir(filePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (ignoredFingerprintDirectories.has(entry.name)) {
        continue;
      }

      await this.addPathToHash(hash, path.join(filePath, entry.name));
    }
  }

  // Runs the release CLI to build and upload an OTA bundle to the local server.
  //
  // `name`      — one of the keys in releaseConfigs ("good-2048", "good-1024", "bad-4096")
  // `overrides` — optional object; currently supports { binaryVersions: { ios, android } }
  //               to publish the bundle under a different binary version than the real app.
  //
  // The CLI reads AWS credentials from environment variables. We pass fake values
  // ("test"/"test") and point AWS_ENDPOINT at our local server so no real S3 is needed.
  //
  // If the bundle for this release name was already built in this run (same name,
  // no overrides), --skip-bundle is passed to reuse the existing zip files and only
  // re-upload to the server — avoiding a redundant Metro build.
  async publishRelease(name, overrides = {}) {
    const config = releaseConfigs.get(name);
    if (config == null) {
      throw new Error(`Unknown release "${name}"`);
    }

    this.log(
      `Publishing release ${name} (bundleVersion=${config.bundleVersion})`
    );

    // Write a tiny JS file that becomes the Metro entry point for this bundle.
    const entryFile = await this.writeGeneratedEntryFile({
      bundleVersion: config.bundleVersion,
      name,
      scenario: config.scenario,
    });

    const outputDir = path.join(this.runRoot, 'builds', name);

    // Only skip the Metro build when no binary-version overrides are in play and the
    // zip files from a previous build actually exist on disk. Checking existence guards
    // against stale in-memory state when files were deleted between test runs.
    const hasOverrides = Object.keys(overrides).length > 0;
    let skipBundle = false;
    if (!hasOverrides) {
      const platformZips = this.platforms.map((platform) =>
        path.join(outputDir, String(config.bundleVersion), `${platform}.zip`)
      );
      const exists = await Promise.all(
        platformZips.map((filePath) =>
          stat(filePath).then(
            () => true,
            () => false
          )
        )
      );
      skipBundle = exists.every(Boolean);
    }

    const args = [
      'publish',
      '--bundle-version',
      String(config.bundleVersion),
      '--entry-file',
      entryFile,
      '--project-root',
      exampleDir,
      '--output-dir',
      outputDir,
    ];

    if (skipBundle) {
      args.push('--skip-bundle');
    }

    // If a test overrides the binary version, pass those flags to the CLI.
    // The CLI will store the manifest under the overridden version path instead
    // of the real app's version, causing the app to get a 404 when it checks.
    if (overrides.binaryVersions?.ios != null) {
      args.push('--ios-binary-version', overrides.binaryVersions.ios);
    }

    if (overrides.binaryVersions?.android != null) {
      args.push('--android-binary-version', overrides.binaryVersions.android);
    }

    const env = {
      ...process.env,
      // Fake AWS credentials — the local server doesn't validate them.
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      // Redirect all S3 calls to our local server.
      AWS_ENDPOINT: `http://127.0.0.1:${this.port}`,
      AWS_PATH: otaBucket,
    };

    this.log(
      `Running OTA release CLI for ${this.platforms.join(', ')}${skipBundle ? ' (reusing existing bundles)' : ''}`
    );
    await runCommand(process.execPath, [cliBin, ...args], {
      cwd: repoRoot,
      env,
    });

    this.log(
      `Published release ${name}${skipBundle ? ' (bundle reused)' : ''}`
    );
  }

  // Creates a minimal JavaScript file that Metro will bundle as the OTA entry point.
  //
  // For 'good' scenarios: registers the App component — the app runs normally.
  // For 'crash' scenarios: throws immediately — simulates a broken OTA bundle
  //   that the app should detect and roll back from.
  //
  // The __OTA_BUNDLE_VERSION__ global is read by the app at runtime to know
  // which bundle version it's currently running.
  async writeGeneratedEntryFile({ bundleVersion, name, scenario }) {
    const generatedRoot = path.join(this.runRoot, 'generated');
    const entryFile = path.join(generatedRoot, `${name}.js`);
    const exampleAppPath = path.relative(
      generatedRoot,
      path.join(exampleDir, 'src', 'AppOta')
    );
    const exampleAppJsonPath = path.relative(
      generatedRoot,
      path.join(exampleDir, 'app.json')
    );
    let source = `globalThis.__OTA_BUNDLE_VERSION__ = ${JSON.stringify(bundleVersion)};\n`;

    if (scenario === 'good') {
      source += [
        "const { AppRegistry } = require('react-native');",
        `const App = require(${JSON.stringify(exampleAppPath)}).default;`,
        `const { name: appName } = require(${JSON.stringify(exampleAppJsonPath)});`,
        '',
        'AppRegistry.registerComponent(appName, () => App);',
        '',
      ].join('\n');
    } else if (scenario === 'crash') {
      source += "throw new Error('Intentional OTA crash for rollback test');\n";
    } else {
      throw new Error(`Unknown OTA scenario "${scenario}"`);
    }

    await mkdir(generatedRoot, { recursive: true });
    await writeFile(entryFile, source);
    return entryFile;
  }

  // Writes the publicUrlBase into examples/0.85/package.json under the "react-native-ota" key.
  // The app reads this value at build time to know where to fetch OTA updates from.
  // We set it to our local server so tests don't touch a real CDN.
  async setPackageJsonPublicUrlBase(publicUrlBase) {
    // Use the backup if available; otherwise read from disk.
    const packageJson = JSON.parse(
      this.packageJsonBackup ?? (await readFile(packageJsonPath, 'utf8'))
    );
    packageJson['react-native-ota'] = {
      ...(packageJson['react-native-ota'] ?? {}),
      publicUrlBase,
    };
    await writeFile(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`
    );
  }

  // Returns the path to the compiled iOS .app bundle inside the DerivedData directory.
  getIosAppPath() {
    return path.join(
      this.iosDerivedDataPath,
      'Build/Products/Release-iphonesimulator/ReactNativeOtaExample.app'
    );
  }

  // Returns the path to the compiled Android release APK.
  getAndroidApkPath() {
    return path.join(otaTestCacheRoot, 'android', 'app-release.apk');
  }

  // Returns the Gradle output path before it is copied into the persistent e2e cache.
  getAndroidBuildOutputApkPath() {
    return path.join(
      exampleDir,
      'android/app/build/outputs/apk/release/app-release.apk'
    );
  }

  async cacheAndroidReleaseApp() {
    const cachedApkPath = this.getAndroidApkPath();
    await mkdir(path.dirname(cachedApkPath), { recursive: true });
    await copyFile(this.getAndroidBuildOutputApkPath(), cachedApkPath);
  }

  // Uninstalls and reinstalls the iOS app on the simulator.
  // This gives us a completely clean install — no cached OTA state, no
  // previously downloaded bundles — so each test starts from a known state.
  async reinstallIosApp() {
    this.log('Reinstalling iOS app');
    await this.ensureIosSimulatorReady();
    const dataDirectory = await this.getIosAppDataDirectory();

    await runCommand(
      'xcrun',
      ['simctl', 'terminate', this.iosDeviceId, bundleId],
      {
        allowFailure: true,
      }
    );

    // allowFailure: true because the app might not be installed yet on the first run.
    await runCommand(
      'xcrun',
      ['simctl', 'uninstall', this.iosDeviceId, bundleId],
      {
        allowFailure: true,
      }
    );
    if (dataDirectory != null) {
      await rm(dataDirectory, { force: true, recursive: true });
    }
    await runCommand('xcrun', [
      'simctl',
      'install',
      this.iosDeviceId,
      this.getIosAppPath(),
    ]);
  }

  // Uninstalls and reinstalls the Android app on the connected device/emulator.
  // Same purpose as reinstallIosApp — ensures a fresh state.
  async reinstallAndroidApp() {
    this.log('Reinstalling Android app');
    await this.ensureAndroidDeviceReady();
    await runCommand(
      'adb',
      ['-s', this.androidDeviceId, 'uninstall', bundleId],
      { allowFailure: true }
    );

    // -r means "reinstall, keeping data" — but since we uninstalled above,
    // this effectively does a fresh install. The flag prevents adb from
    // failing if a previous version is somehow still present.
    await runCommand('adb', [
      '-s',
      this.androidDeviceId,
      'install',
      '-r',
      this.getAndroidApkPath(),
    ]);
  }

  // Dispatches to the platform-specific reinstall method.
  async reinstallFreshApp(platform) {
    if (platform === 'ios') {
      await this.reinstallIosApp();
      return;
    }

    await this.reinstallAndroidApp();
  }

  // Requests reduced motion on iOS. This does not remove every Core Animation,
  // but it cuts down simulator UI transition delays and improves test stability.
  async disableIosAnimations() {
    await this.ensureIosSimulatorReady();
    await runCommand('xcrun', [
      'simctl',
      'spawn',
      this.iosDeviceId,
      'defaults',
      'write',
      'com.apple.Accessibility',
      'ReduceMotionEnabled',
      '-bool',
      'true',
    ]);
    await runCommand('xcrun', [
      'simctl',
      'spawn',
      this.iosDeviceId,
      'defaults',
      'write',
      'com.apple.Accessibility',
      'ReduceMotionAutoplayAnimatedImagesEnabled',
      '-bool',
      'false',
    ]);
    await runCommand('xcrun', [
      'simctl',
      'spawn',
      this.iosDeviceId,
      'defaults',
      'write',
      'com.apple.Accessibility',
      'ReduceMotionPreferCrossFadeTransitionsEnabled',
      '-bool',
      'true',
    ]);
    await runCommand('xcrun', [
      'simctl',
      'spawn',
      this.iosDeviceId,
      'defaults',
      'write',
      'com.apple.springboard',
      'ReduceMotion',
      '-bool',
      'true',
    ]);
    await runCommand(
      'xcrun',
      [
        'simctl',
        'spawn',
        this.iosDeviceId,
        'notifyutil',
        '-p',
        'com.apple.Accessibility.ReduceMotionStatusDidChange',
      ],
      { allowFailure: true }
    );
    await runCommand(
      'xcrun',
      [
        'simctl',
        'spawn',
        this.iosDeviceId,
        'notifyutil',
        '-p',
        'com.apple.accessibility.settings.changed',
      ],
      { allowFailure: true }
    );
    await runCommand(
      'xcrun',
      ['simctl', 'spawn', this.iosDeviceId, 'killall', 'cfprefsd'],
      { allowFailure: true }
    );
  }

  // Turns off all Android system animations.
  // Animations add unpredictable delays between UI transitions; disabling them
  // makes UI interactions more reliable.
  async disableAndroidAnimations() {
    await this.ensureAndroidDeviceReady();
    await runCommand('adb', [
      '-s',
      this.androidDeviceId,
      'shell',
      'settings',
      'put',
      'global',
      'window_animation_scale',
      '0',
    ]);
    await runCommand('adb', [
      '-s',
      this.androidDeviceId,
      'shell',
      'settings',
      'put',
      'global',
      'transition_animation_scale',
      '0',
    ]);
    await runCommand('adb', [
      '-s',
      this.androidDeviceId,
      'shell',
      'settings',
      'put',
      'global',
      'animator_duration_scale',
      '0',
    ]);
  }

  // Runs fn(platform) for every platform in this.platforms, in parallel.
  // Use this instead of a for-loop when each platform's work is independent.
  async runForEachPlatform(fn) {
    for (const platform of this.platforms) {
      await fn(platform);
    }
  }

  // Opens the app on the iOS simulator using argent, waits for the OTA check to
  // complete, then reads and returns the UI text.
  //
  // Settling is detected by polling the preferences plist:
  //   - If plist state changed since before launch → OTA check wrote new state.
  //   - If plist state is unchanged but currentPending === false and a minimum
  //     time has elapsed → OTA check ran with no result (e.g. lower version ignored).
  //
  // `relaunch: true` (the default) force-quits the app before opening it,
  // ensuring we see the startup OTA-check flow from scratch.
  // Pass `relaunch: false` to open without terminating first.
  async launchIosAndReadUi({
    expectedBundleLabel = null,
    expectedBundleVersion = null,
    relaunch = true,
  } = {}) {
    await this.ensureIosSimulatorReady();

    const stateBefore = JSON.stringify(await this.readIosState());
    const launchTime = Date.now();

    if (relaunch) {
      await runCommand('argent', [
        'run',
        'restart-app',
        '--udid',
        this.iosDeviceId,
        '--bundleId',
        bundleId,
      ]);
    } else {
      await runCommand('argent', [
        'run',
        'launch-app',
        '--udid',
        this.iosDeviceId,
        '--bundleId',
        bundleId,
      ]);
    }

    this.log('Waiting for iOS app state to settle');
    await this.waitForIosState({
      description: 'app settled after launch',
      predicate: (state) => {
        if (expectedBundleVersion != null) {
          return (
            state.current?.bundleVersion === String(expectedBundleVersion) &&
            state.currentPending === false
          );
        }

        const stateChanged = JSON.stringify(state) !== stateBefore;
        const elapsed = Date.now() - launchTime;

        // OTA bundle applied and confirmed — settle immediately.
        // stateChanged guards against re-applying an already-current bundle.
        if (
          stateChanged &&
          state.current != null &&
          state.currentPending === false
        )
          return true;

        // No OTA update (or check completed with no action): wait a minimum
        // time so the OTA network request finishes and React has time to render.
        if (state.currentPending === false && elapsed >= 8_000) return true;

        return false;
      },
      timeoutMs: 30_000,
    });

    // After the plist settles the UI may still be rendering. Poll until the
    // accessibility tree contains the expected label text.
    this.log('Waiting for iOS UI assertions to appear');
    return this.waitForUiAssertions({
      commandArgs: ['run', 'describe', '--udid', this.iosDeviceId, '--json'],
      description:
        expectedBundleLabel == null
          ? 'Bundle label to appear in iOS UI'
          : `iOS UI bundle label ${expectedBundleLabel}`,
      expectedBundleLabel,
    });
  }

  // Launches the iOS app via xcrun simctl and waits for the bad-OTA pending
  // state to be written to the plist (currentPending === true).
  // Used in the rollback test when we want the app to start but don't need to
  // read the UI immediately (we read the plist state instead).
  async triggerIosLaunch() {
    await this.ensureIosSimulatorReady();

    // Terminate first so the launch command starts a fresh process.
    await runCommand(
      'xcrun',
      ['simctl', 'terminate', this.iosDeviceId, bundleId],
      {
        allowFailure: true,
      }
    );
    await runCommand(
      'xcrun',
      ['simctl', 'launch', this.iosDeviceId, bundleId],
      {
        allowFailure: true,
      }
    );

    // Wait until the app downloads, runs, crashes, and marks the bundle pending.
    await this.waitForIosState({
      description: 'bad OTA bundle marked as pending',
      predicate: (state) => state.currentPending === true,
      timeoutMs: 30_000,
    });
  }

  // Reads the OTA persisted state from the iOS app's preferences plist.
  //
  // iOS apps store UserDefaults in a binary plist file inside their data container.
  // We use xcrun simctl to find the container path, then a small inline Python
  // script to decode the binary plist and extract the JSON state string the app
  // writes under the "com.imcsorin.reactnativeota.state" key.
  //
  // Returns a plain JS object with properties like:
  //   { current: { bundleVersion: "2048" }, currentPending: false }
  async readIosState() {
    const dataDirectory = await this.getIosAppDataDirectory();
    if (dataDirectory == null) {
      return {};
    }
    const plistPath = path.join(
      dataDirectory,
      'Library',
      'Preferences',
      `${bundleId}.plist`
    );

    // Inline Python script to read the binary plist and print the OTA state as UTF-8.
    // Python's plistlib handles both binary and XML plist formats.
    const pythonSource = [
      'import json',
      'import plistlib',
      'import sys',
      'try:',
      '    with open(sys.argv[1], "rb") as file:',
      '        data = plistlib.load(file)',
      'except FileNotFoundError:',
      '    print("{}")',
      '    raise SystemExit(0)',
      // The value is stored as raw bytes (NSData) — decode to a string before parsing.
      'state = data.get("com.imcsorin.reactnativeota.state", b"{}")',
      'if isinstance(state, (bytes, bytearray)):',
      '    print(state.decode("utf-8"))',
      'else:',
      '    print(json.dumps(state))',
    ].join('\n');
    // The plist file is only created after the app first writes to UserDefaults.
    // On a fresh install it won't exist yet — return an empty state in that case.
    try {
      await stat(plistPath);
    } catch {
      return {};
    }

    const decoded = await runCommand('python', ['-c', pythonSource, plistPath]);

    return JSON.parse(decoded.stdout.trim());
  }

  // Polls readIosState() until `predicate(state)` returns true, then returns the state.
  // Throws if the predicate hasn't been satisfied within `timeoutMs` milliseconds.
  //
  // Why poll? iOS writes the plist asynchronously after the UI renders, so a
  // single immediate read might see stale data.
  async waitForIosState({ description, predicate, timeoutMs = 30_000 }) {
    const deadline = Date.now() + timeoutMs;
    let lastState = null;
    let attempts = 0;

    while (Date.now() < deadline) {
      attempts += 1;
      lastState = await this.readIosState();

      if (predicate(lastState)) {
        return lastState;
      }

      if (attempts % 5 === 0) {
        this.log(`Still waiting for iOS ${description}...`);
      }

      await sleep(1_000);
    }

    throw new Error(
      `${description} did not settle within ${timeoutMs}ms. Last state: ${JSON.stringify(lastState)}`
    );
  }

  // Launches the Android app and returns both the parsed UI and the full logcat output.
  //
  // Steps:
  //   1. Clear the logcat buffer so we only capture logs from this launch.
  //   2. Force-stop the app (in case it's still running from a previous step).
  //   3. Launch it via `adb shell monkey` — the standard way to start an app
  //      without a physical tap.
  //   4. Poll logcat until the OTA-settled sentinel line appears.
  //   5. Dump the current UI hierarchy and parse it for our assertions.
  async launchAndroidAndReadUi({ expectedBundleLabel = null } = {}) {
    await this.ensureAndroidDeviceReady();
    await runCommand('adb', ['-s', this.androidDeviceId, 'logcat', '-c']); // clear logcat buffer

    await runCommand(
      'adb',
      ['-s', this.androidDeviceId, 'shell', 'am', 'force-stop', bundleId],
      {
        allowFailure: true,
      }
    );
    await runCommand('adb', [
      '-s',
      this.androidDeviceId,
      'shell',
      'monkey',
      '-p',
      bundleId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1', // send exactly one launch intent
    ]);

    this.log('Waiting for Android OTA state to settle');
    const logs = await this.waitForAndroidLog(ANDROID_OTA_SETTLED_LOG);

    this.log('Reading Android UI assertions');
    return {
      logs,
      ui: await this.waitForUiAssertions({
        commandArgs: [
          'run',
          'describe',
          '--udid',
          this.androidDeviceId,
          '--json',
        ],
        description:
          expectedBundleLabel == null
            ? 'Bundle label to appear in Android UI'
            : `Android UI bundle label ${expectedBundleLabel}`,
        expectedBundleLabel,
      }),
    };
  }

  // Like launchAndroidAndReadUi() but only returns the logcat output.
  // Used in tests that need to check log lines from a second launch (e.g. rollback)
  // but don't need the UI state from that specific launch.
  async triggerAndroidLaunchAndReadLogs() {
    await this.ensureAndroidDeviceReady();
    await runCommand('adb', ['-s', this.androidDeviceId, 'logcat', '-c']);

    await runCommand(
      'adb',
      ['-s', this.androidDeviceId, 'shell', 'am', 'force-stop', bundleId],
      {
        allowFailure: true,
      }
    );
    await runCommand('adb', [
      '-s',
      this.androidDeviceId,
      'shell',
      'monkey',
      '-p',
      bundleId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);

    return this.waitForAndroidLog(ANDROID_OTA_SETTLED_LOG);
  }

  // Polls `adb logcat -d` until the output contains `pattern`, then returns
  // the full log string. Throws if the pattern is not seen within `timeoutMs`.
  async waitForAndroidLog(pattern, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;

    while (Date.now() < deadline) {
      attempts += 1;
      const result = await runCommand(
        'adb',
        ['-s', this.androidDeviceId, 'logcat', '-d'],
        {
          allowFailure: true,
        }
      );

      if (result.stdout.includes(pattern)) {
        return result.stdout;
      }

      if (attempts % 5 === 0) {
        this.log(`Still waiting for Android log pattern "${pattern}"...`);
      }

      await sleep(1_000);
    }

    throw new Error(
      `Android log pattern "${pattern}" not seen within ${timeoutMs}ms`
    );
  }

  async waitForUiAssertions({
    commandArgs,
    description,
    expectedBundleLabel = null,
    timeoutMs = 15_000,
  }) {
    const deadline = Date.now() + timeoutMs;
    let lastParsedUi = null;

    while (Date.now() < deadline) {
      const snapshot = await runCommand('argent', commandArgs, {
        allowFailure: true,
      });

      if (snapshot.stdout.includes('Bundle label')) {
        try {
          lastParsedUi = parseUiAssertions(snapshot.stdout);

          if (
            expectedBundleLabel == null ||
            lastParsedUi.bundleLabel === expectedBundleLabel
          ) {
            return lastParsedUi;
          }
        } catch {
          // Keep polling until the full assertion text is visible.
        }
      }

      await sleep(1_000);
    }

    throw new Error(
      expectedBundleLabel == null || lastParsedUi == null
        ? `Timed out waiting for ${description}`
        : `Timed out waiting for ${description}. Last bundle label: ${lastParsedUi.bundleLabel}`
    );
  }

  async getIosAppDataDirectory() {
    await this.ensureIosSimulatorReady();

    let result = await runCommand(
      'xcrun',
      ['simctl', 'get_app_container', this.iosDeviceId, bundleId, 'data'],
      { allowFailure: true }
    );

    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (
      combinedOutput.includes(
        'Unable to lookup in current state: Shutting Down'
      )
    ) {
      await this.ensureIosSimulatorReady();
      result = await runCommand(
        'xcrun',
        ['simctl', 'get_app_container', this.iosDeviceId, bundleId, 'data'],
        { allowFailure: true }
      );
    }

    const dataDirectory = result.stdout.trim();
    return dataDirectory.length > 0 ? dataDirectory : null;
  }

  // Finds a booted iOS simulator (or boots one) and stores its UDID in this.iosDeviceId.
  // After the first call this is a no-op — it just waits for the already-selected
  // simulator to finish booting (in case it's still starting up).
  async ensureIosSimulatorReady() {
    if (this.iosDeviceId != null) {
      // bootstatus -b blocks until the simulator is fully booted.
      const bootStatus = await runCommand(
        'xcrun',
        ['simctl', 'bootstatus', this.iosDeviceId, '-b'],
        { allowFailure: true }
      );

      if (bootStatus.code === 0) {
        return;
      }

      await runCommand('open', ['-a', 'Simulator'], { allowFailure: true });
      await runCommand('xcrun', ['simctl', 'boot', this.iosDeviceId], {
        allowFailure: true,
      });
      await runCommand('xcrun', [
        'simctl',
        'bootstatus',
        this.iosDeviceId,
        '-b',
      ]);
      return;
    }

    // List all available simulators as JSON and pick the best candidate.
    const result = await runCommand('xcrun', [
      'simctl',
      'list',
      'devices',
      'available',
      '--json',
    ]);
    const devicesByRuntime = JSON.parse(result.stdout).devices ?? {};
    const candidates = Object.values(devicesByRuntime)
      .flat()
      .filter((device) => device.isAvailable !== false);

    // Preference order:
    //   1. A simulator that is already booted (fastest — no wait needed)
    //   2. Any iPhone simulator
    //   3. Whatever is available
    const preferredDevice =
      candidates.find((device) => device.state === 'Booted') ??
      candidates.find((device) => device.name.includes('iPhone')) ??
      candidates[0];

    if (preferredDevice == null) {
      throw new Error('No available iOS simulator device was found.');
    }

    this.iosDeviceId = preferredDevice.udid;

    // Open the Simulator app (allowFailure: true because it might already be open).
    await runCommand('open', ['-a', 'Simulator'], { allowFailure: true });

    // Boot the device (allowFailure: true because it might already be booted).
    await runCommand('xcrun', ['simctl', 'boot', this.iosDeviceId], {
      allowFailure: true,
    });

    // Block until the simulator is fully ready.
    await runCommand('xcrun', ['simctl', 'bootstatus', this.iosDeviceId, '-b']);
  }

  // Ensures an Android device or emulator is connected and fully booted.
  // If no device is connected, starts the first AVD (Android Virtual Device)
  // found on this machine and waits up to 5 minutes for it to come online.
  async ensureAndroidDeviceReady() {
    let devices = await this.listAndroidDevices();

    // If no device is connected and we haven't already started one, start the emulator.
    if (devices.length === 0 && !this.androidEmulatorStarted) {
      const avdList = await runCommand('emulator', ['-list-avds']);
      const avdNames = avdList.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      if (avdNames.length === 0) {
        throw new Error(
          'No Android device is connected and no AVD is available to start.'
        );
      }

      this.log(`Starting Android emulator ${avdNames[0]}`);

      // startDetachedProcess fires and forgets — the emulator keeps running
      // in the background. We then poll until adb sees it come online.
      startDetachedProcess('emulator', [
        '-avd',
        avdNames[0],
        '-netdelay',
        'none',
        '-netspeed',
        'full',
      ]);
      this.androidEmulatorStarted = true;
    }

    const deadline = Date.now() + 5 * 60 * 1000; // 5-minute timeout

    // Poll until adb reports at least one connected device.
    while (devices.length === 0 && Date.now() < deadline) {
      await sleep(5_000);
      devices = await this.listAndroidDevices();
    }

    if (devices.length === 0) {
      throw new Error('Timed out waiting for an Android device to connect.');
    }

    this.androidDeviceId = devices[0].split(/\s+/)[0];

    // wait-for-device blocks until adb can talk to the device.
    await runCommand('adb', ['-s', this.androidDeviceId, 'wait-for-device']);

    // Even after adb connects, Android needs more time to finish booting.
    // Poll the sys.boot_completed system property until it equals "1".
    while (Date.now() < deadline) {
      const bootCompleted = await runCommand('adb', [
        '-s',
        this.androidDeviceId,
        'shell',
        'getprop',
        'sys.boot_completed',
      ]);

      if (bootCompleted.stdout.trim() === '1') {
        await this.waitForAndroidPackageManager();
        return;
      }

      await sleep(3_000);
    }

    throw new Error(
      'Timed out waiting for the Android device to finish booting.'
    );
  }

  // Parses the output of `adb devices` and returns only lines that represent
  // a fully connected device (as opposed to "offline" or "unauthorized" devices).
  async listAndroidDevices() {
    const result = await runCommand('adb', ['devices']);

    // The first line is the header "List of devices attached"; skip it.
    // Each remaining non-empty line ends with "\tdevice" if fully connected.
    return result.stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => /\sdevice$/.test(line));
  }

  async waitForAndroidPackageManager(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await runCommand(
        'adb',
        ['-s', this.androidDeviceId, 'shell', 'cmd', 'package', 'help'],
        { allowFailure: true }
      );
      const combinedOutput = `${result.stdout}\n${result.stderr}`;

      if (
        result.code === 0 &&
        !combinedOutput.includes("Can't find service: package")
      ) {
        return;
      }

      await sleep(1_000);
    }

    throw new Error(
      'Timed out waiting for Android package manager service to become ready.'
    );
  }
}

function truncateText(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}
