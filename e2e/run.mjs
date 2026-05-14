#!/usr/bin/env node

// Entry point for the e2e test runner.
//
// Run with:
//   node e2e/run.mjs [--platform <ios|android|all>] [--test <id,...>|all]
//                    [--host-ip <address>] [--port <number>]
//                    [--skip-build] [--list-tests]
//
// Examples:
//   node e2e/run.mjs                          # run all tests on all platforms
//   node e2e/run.mjs --platform ios           # iOS only
//   node e2e/run.mjs --test ota-update        # one specific test
//   node e2e/run.mjs --skip-build             # reuse existing .app/.apk, skip compilation
//   node e2e/run.mjs --list-tests             # print available test IDs

import { TestContext } from './context.mjs';
import { testDefinitions } from './tests/index.mjs';
import { detectHostIp, formatError, toCamelCase } from './utils.mjs';

const supportedPlatforms = ['ios', 'android'];

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // --list-tests just prints the available test IDs and exits without running anything.
  if (options.listTests) {
    for (const test of testDefinitions) {
      console.log(`${test.id} - ${test.title}`);
    }
    return 0;
  }

  const platforms = resolvePlatforms(options.platform);
  const selectedTests = resolveTests(options.test);

  // The host IP is the address the iOS simulator and Android emulator use to
  // reach the OTA server running on this machine. detectHostIp() picks the
  // first non-loopback IPv4 address automatically; override with --host-ip
  // if the machine has multiple network interfaces.
  const hostIp = options.hostIp ?? detectHostIp();
  const port = Number(options.port ?? 31337);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${options.port}`);
  }

  const context = new TestContext({
    hostIp,
    platforms,
    port,
    selectedTests,
    skipBuild: options.skipBuild === true,
  });

  return context.run();
}

// Parses the raw argv array into a plain options object.
// Supports two forms:
//   --flag          → options.flag = true   (boolean flags)
//   --key value     → options.key = value   (value flags)
// Flag names are converted from kebab-case to camelCase (e.g. --host-ip → hostIp).
function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (current === '--list-tests') {
      options.listTests = true;
      continue;
    }

    if (current === '--skip-build') {
      options.skipBuild = true;
      continue;
    }

    if (!current.startsWith('--')) {
      throw new Error(`Unexpected argument: ${current}`);
    }

    const value = argv[index + 1];

    // Every other flag requires a value. If the next token is another flag
    // (or there is no next token), the flag is missing its value.
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for ${current}`);
    }

    options[toCamelCase(current.slice(2))] = value;
    index += 1; // skip the value token on the next iteration
  }

  return options;
}

// Converts the --platform option string into an array of platform names.
// "all" (the default) expands to ['ios', 'android'].
// A comma-separated list like "ios,android" is split and deduplicated.
function resolvePlatforms(platformOption = 'all') {
  const normalized = platformOption.trim().toLowerCase();

  if (normalized === 'all') {
    return [...supportedPlatforms];
  }

  const platforms = [...new Set(normalized.split(',').map((part) => part.trim()))].filter(
    Boolean
  );

  if (platforms.length === 0) {
    throw new Error('Expected --platform to be all, ios, android, or ios,android');
  }

  for (const platform of platforms) {
    if (!supportedPlatforms.includes(platform)) {
      throw new Error(`Unsupported platform "${platform}"`);
    }
  }

  return platforms;
}

// Converts the --test option string into an array of test definition objects.
// "all" (the default) returns every test in the order they appear in index.mjs.
// A comma-separated list of IDs (e.g. "ota-update,rollback-bad-update") is
// looked up against the registered definitions; unknown IDs throw an error.
function resolveTests(testOption = 'all') {
  const normalized = testOption.trim().toLowerCase();

  if (normalized === 'all') {
    return [...testDefinitions];
  }

  const requestedIds = [...new Set(normalized.split(',').map((part) => part.trim()))].filter(
    Boolean
  );

  if (requestedIds.length === 0) {
    throw new Error('Expected --test to be all or a comma-separated list of test ids');
  }

  return requestedIds.map((requestedId) => {
    const definition = testDefinitions.find((test) => test.id === requestedId);

    if (definition == null) {
      throw new Error(
        `Unknown test "${requestedId}". Use --list-tests to view available tests.`
      );
    }

    return definition;
  });
}

// Top-level await: run main() and exit with its return code.
// Any unhandled error is caught, logged, and exits with code 1.
main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error(`[ota:test] fatal: ${formatError(error)}`);
    process.exit(1);
  });
