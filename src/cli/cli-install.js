const fs = require('fs');
const path = require('path');
const { spawn } = require('node:child_process');

const SUPPORTED_PLATFORMS = ['ios', 'android'];

function normalizePlatforms(platforms = SUPPORTED_PLATFORMS) {
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('Expected one or more install platforms.');
  }

  const normalizedPlatforms = [
    ...new Set(platforms.map((platform) => platform.trim())),
  ];

  for (const platform of normalizedPlatforms) {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw new Error(`Unsupported install platform "${platform}".`);
    }
  }

  return normalizedPlatforms;
}

function normalizePublicUrlBase(value) {
  if (value == null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error('Expected --public-url-base to be a string.');
  }

  const normalizedValue = value.trim();
  return normalizedValue.length > 0 ? normalizedValue : null;
}

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function ensureJsonDependency(packageJson, packageName) {
  const dependencies = isPlainObject(packageJson.dependencies)
    ? { ...packageJson.dependencies }
    : {};
  const existingDependencyVersion =
    typeof dependencies[packageName] === 'string'
      ? dependencies[packageName]
      : typeof packageJson.devDependencies?.[packageName] === 'string'
        ? packageJson.devDependencies[packageName]
        : null;

  if (
    existingDependencyVersion != null &&
    dependencies[packageName] === existingDependencyVersion
  ) {
    return {
      nextPackageJson: packageJson,
      updated: false,
    };
  }

  dependencies[packageName] = existingDependencyVersion ?? 'latest';
  const devDependencies = isPlainObject(packageJson.devDependencies)
    ? { ...packageJson.devDependencies }
    : null;

  if (devDependencies != null) {
    delete devDependencies[packageName];
  }

  return {
    nextPackageJson: {
      ...packageJson,
      dependencies: sortObjectKeys(dependencies),
      ...(devDependencies != null
        ? { devDependencies: sortObjectKeys(devDependencies) }
        : {}),
    },
    updated: true,
  };
}

function ensurePublicUrlBase(packageJson, publicUrlBase) {
  if (publicUrlBase == null) {
    return {
      nextPackageJson: packageJson,
      updated: false,
    };
  }

  const existingConfig = isPlainObject(packageJson['react-native-ota'])
    ? packageJson['react-native-ota']
    : {};
  const { manifestUrl: _removedManifestUrl, ...restConfig } = existingConfig;
  const nextConfig = {
    ...restConfig,
    publicUrlBase,
  };

  if (
    existingConfig.publicUrlBase === publicUrlBase &&
    !('manifestUrl' in existingConfig)
  ) {
    return {
      nextPackageJson: packageJson,
      updated: false,
    };
  }

  return {
    nextPackageJson: {
      ...packageJson,
      'react-native-ota': nextConfig,
    },
    updated: true,
  };
}

function formatPackageJson(packageJson) {
  return ensureTrailingNewline(`${JSON.stringify(packageJson, null, 2)}`);
}

function patchAppPackageJson(source, { packageName, publicUrlBase }) {
  const packageJson = JSON.parse(source);
  const dependencyResult = ensureJsonDependency(packageJson, packageName);
  const publicUrlBaseResult = ensurePublicUrlBase(
    dependencyResult.nextPackageJson,
    normalizePublicUrlBase(publicUrlBase)
  );

  return {
    contents: formatPackageJson(publicUrlBaseResult.nextPackageJson),
    updatedDependency: dependencyResult.updated,
    updatedPublicUrlBase: publicUrlBaseResult.updated,
  };
}

function patchAppDelegateSwift(source) {
  let nextSource = source;

  if (!nextSource.includes('import ReactNativeOta')) {
    const importAnchor = 'import ReactAppDependencyProvider\n';

    if (!nextSource.includes(importAnchor)) {
      throw new Error(
        'Unsupported iOS AppDelegate.swift layout. Expected ReactAppDependencyProvider import.'
      );
    }

    nextSource = nextSource.replace(
      importAnchor,
      `${importAnchor}import ReactNativeOta\n`
    );
  }

  if (!nextSource.includes('RNOtaManager.shared.bundleURL()')) {
    const embeddedBundleExpression =
      /^(\s*)(return\s+)?Bundle\.main\.url\(forResource:\s*"main",\s*withExtension:\s*"jsbundle"\)\s*$/m;
    const embeddedBundleMatch = nextSource.match(embeddedBundleExpression);

    if (embeddedBundleMatch == null) {
      throw new Error(
        'Unsupported iOS AppDelegate.swift layout. Expected the default embedded bundle lookup.'
      );
    }

    nextSource = nextSource.replace(
      embeddedBundleExpression,
      `${embeddedBundleMatch[1]}${embeddedBundleMatch[2] ?? ''}RNOtaManager.shared.bundleURL()`
    );
  }

  return nextSource;
}

function patchMainApplicationKotlin(source) {
  let nextSource = source;

  if (
    !nextSource.includes(
      'import com.imcsorin.reactnativeota.ReactNativeOtaController'
    )
  ) {
    const importAnchor =
      /^import com\.facebook\.react\.defaults\.DefaultReactHost\.getDefaultReactHost\s*$/m;

    if (!importAnchor.test(nextSource)) {
      throw new Error(
        'Unsupported Android MainApplication.kt layout. Expected DefaultReactHost import.'
      );
    }

    nextSource = nextSource.replace(
      importAnchor,
      '$&\nimport com.imcsorin.reactnativeota.ReactNativeOtaController'
    );
  }

  if (!nextSource.includes('override fun getJSBundleFile(): String? =')) {
    const developerSupportAnchor =
      /^(\s*)override fun getUseDeveloperSupport\(\): Boolean = BuildConfig\.DEBUG\s*$/m;
    const developerSupportMatch = nextSource.match(developerSupportAnchor);

    if (developerSupportMatch == null) {
      throw new Error(
        'Unsupported Android MainApplication.kt layout. Expected getUseDeveloperSupport override.'
      );
    }

    const indent = developerSupportMatch[1];
    const nestedIndent = `${indent}  `;
    nextSource = nextSource.replace(
      developerSupportAnchor,
      `${developerSupportMatch[0]}\n\n${indent}override fun getJSBundleFile(): String? =\n${nestedIndent}ReactNativeOtaController.getJSBundleFile(this@MainApplication) {\n${nestedIndent}  reactNativeHost.clear()\n${nestedIndent}  currentReactHost = null\n${nestedIndent}}`
    );
  }

  if (!nextSource.includes('private var currentReactHost: ReactHost? = null')) {
    const reactHostRegex =
      /^(?<indent>\s*)override val reactHost: ReactHost\s*\n[\s\S]*?(?=^\k<indent>override fun onCreate\(\))/m;
    const reactHostMatch = nextSource.match(reactHostRegex);

    if (reactHostMatch == null) {
      throw new Error(
        'Unsupported Android MainApplication.kt layout. Expected the default reactHost getter.'
      );
    }

    const indent = reactHostMatch.groups?.indent ?? '';
    const getterIndent = `${indent}  `;
    const bodyIndent = `${getterIndent}  `;
    const continuationIndent = `${bodyIndent}  `;
    nextSource = nextSource.replace(
      reactHostMatch[0],
      `${indent}private var currentReactHost: ReactHost? = null\n\n${indent}override val reactHost: ReactHost\n${getterIndent}get() {\n${bodyIndent}if (currentReactHost == null) {\n${continuationIndent}currentReactHost =\n${continuationIndent}  getDefaultReactHost(\n${continuationIndent}    context = applicationContext,\n${continuationIndent}    reactNativeHost = reactNativeHost\n${continuationIndent}  )\n${bodyIndent}}\n\n${bodyIndent}return currentReactHost!!\n${getterIndent}}\n\n`
    );
  }

  return nextSource;
}

async function installProject({
  packageManager,
  packageName,
  platforms = SUPPORTED_PLATFORMS,
  publicUrlBase,
  projectRoot,
  skipPackageInstall = false,
  skipPods = false,
}) {
  const normalizedPlatforms = normalizePlatforms(platforms);
  const normalizedProjectRoot = path.resolve(projectRoot);
  const packageJsonPath = path.join(normalizedProjectRoot, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Could not find package.json at ${packageJsonPath}`);
  }

  const originalPackageJson = await fs.promises.readFile(
    packageJsonPath,
    'utf8'
  );
  const packageJsonPatch = patchAppPackageJson(originalPackageJson, {
    packageName,
    publicUrlBase,
  });
  const existingPackageJson = JSON.parse(originalPackageJson);
  const resolvedPackageManager =
    packageManager ?? detectPackageManager(normalizedProjectRoot);
  const packageAlreadyInstalled =
    typeof existingPackageJson.dependencies?.[packageName] === 'string' ||
    typeof existingPackageJson.devDependencies?.[packageName] === 'string';
  const needsPackageInstall =
    !skipPackageInstall &&
    (!packageAlreadyInstalled || packageJsonPatch.updatedDependency);

  if (packageJsonPatch.contents !== originalPackageJson) {
    await fs.promises.writeFile(packageJsonPath, packageJsonPatch.contents);
  }

  const modifiedFiles = [];

  if (packageJsonPatch.contents !== originalPackageJson) {
    modifiedFiles.push(path.relative(normalizedProjectRoot, packageJsonPath));
  }

  if (needsPackageInstall) {
    await runPackageInstall({
      packageManager: resolvedPackageManager,
      packageName,
      projectRoot: normalizedProjectRoot,
    });
  }

  let iosPodInstallRan = false;

  if (normalizedPlatforms.includes('ios')) {
    const appDelegatePath = await findSingleFile({
      missingMessage:
        'Could not find ios/**/AppDelegate.swift. The install command currently supports Swift AppDelegate projects only.',
      multipleMessage:
        'Found multiple ios/**/AppDelegate.swift files. Re-run with --platform android or patch iOS manually.',
      rootPath: path.join(normalizedProjectRoot, 'ios'),
      test: (candidatePath) =>
        path.basename(candidatePath) === 'AppDelegate.swift',
    });

    if (appDelegatePath != null) {
      const originalContents = await fs.promises.readFile(
        appDelegatePath,
        'utf8'
      );
      const nextContents = patchAppDelegateSwift(originalContents);

      if (nextContents !== originalContents) {
        await fs.promises.writeFile(appDelegatePath, nextContents);
        modifiedFiles.push(
          path.relative(normalizedProjectRoot, appDelegatePath)
        );
      }

      if (!skipPods) {
        await runPodInstall(normalizedProjectRoot);
        iosPodInstallRan = true;
      }
    }
  }

  if (normalizedPlatforms.includes('android')) {
    const mainApplicationPath = await findSingleFile({
      missingMessage:
        'Could not find android/app/src/main/java/**/MainApplication.kt. The install command currently supports Kotlin MainApplication projects only.',
      multipleMessage:
        'Found multiple Android MainApplication.kt files. Re-run with --platform ios or patch Android manually.',
      rootPath: path.join(
        normalizedProjectRoot,
        'android',
        'app',
        'src',
        'main',
        'java'
      ),
      test: (candidatePath) =>
        path.basename(candidatePath) === 'MainApplication.kt',
    });

    if (mainApplicationPath != null) {
      const originalContents = await fs.promises.readFile(
        mainApplicationPath,
        'utf8'
      );
      const nextContents = patchMainApplicationKotlin(originalContents);

      if (nextContents !== originalContents) {
        await fs.promises.writeFile(mainApplicationPath, nextContents);
        modifiedFiles.push(
          path.relative(normalizedProjectRoot, mainApplicationPath)
        );
      }
    }
  }

  return {
    iosPodInstallRan,
    publicUrlBase: normalizePublicUrlBase(publicUrlBase),
    modifiedFiles,
    packageAlreadyInstalled,
    packageInstalled: needsPackageInstall,
    packageJsonUpdated: packageJsonPatch.contents !== originalPackageJson,
    packageManager: resolvedPackageManager,
    platforms: normalizedPlatforms,
    projectRoot: normalizedProjectRoot,
  };
}

function detectPackageManager(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }

  if (
    fs.existsSync(path.join(projectRoot, 'yarn.lock')) ||
    fs.existsSync(path.join(projectRoot, '.yarnrc.yml'))
  ) {
    return 'yarn';
  }

  if (
    fs.existsSync(path.join(projectRoot, 'bun.lockb')) ||
    fs.existsSync(path.join(projectRoot, 'bun.lock'))
  ) {
    return 'bun';
  }

  if (fs.existsSync(path.join(projectRoot, 'package-lock.json'))) {
    return 'npm';
  }

  return 'npm';
}

async function findSingleFile({
  missingMessage,
  multipleMessage,
  rootPath,
  test,
}) {
  if (!fs.existsSync(rootPath)) {
    return null;
  }

  const matches = await findFiles(rootPath, test);

  if (matches.length === 0) {
    throw new Error(missingMessage);
  }

  if (matches.length > 1) {
    throw new Error(multipleMessage);
  }

  return matches[0];
}

async function findFiles(rootPath, test) {
  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const matches = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      matches.push(...(await findFiles(entryPath, test)));
      continue;
    }

    if (test(entryPath)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

async function runPackageInstall({ packageManager, packageName, projectRoot }) {
  switch (packageManager) {
    case 'npm':
      await runCommand('npm', ['install', packageName], projectRoot);
      return;
    case 'pnpm':
      await runCommand('pnpm', ['add', packageName], projectRoot);
      return;
    case 'yarn':
      await runCommand('yarn', ['add', packageName], projectRoot);
      return;
    case 'bun':
      await runCommand('bun', ['add', packageName], projectRoot);
      return;
    default:
      throw new Error(`Unsupported package manager "${packageManager}".`);
  }
}

async function runPodInstall(projectRoot) {
  const iosDirectory = path.join(projectRoot, 'ios');

  if (!fs.existsSync(iosDirectory)) {
    return;
  }

  const bundleCommand = fs.existsSync(path.join(projectRoot, 'Gemfile'))
    ? ['bundle', ['exec', 'pod', 'install']]
    : ['pod', ['install']];

  await runCommand(bundleCommand[0], bundleCommand[1], iosDirectory);
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Command failed (${command} ${args.join(' ')}) with exit code ${code ?? 'unknown'}.`
        )
      );
    });
  });
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function sortObjectKeys(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([leftKey], [rightKey]) =>
      leftKey.localeCompare(rightKey)
    )
  );
}

module.exports = {
  detectPackageManager,
  installProject,
  normalizePublicUrlBase,
  patchAppDelegateSwift,
  patchAppPackageJson,
  patchMainApplicationKotlin,
};
