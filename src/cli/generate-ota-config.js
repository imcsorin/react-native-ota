#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const { resolveOtaPackageConfig } = require('./ota-package-config');

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }

    const value = argv[index + 1];

    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`);
    }

    args[argument.slice(2)] = value;
    index += 1;
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const format = args.format ?? 'json';
  const searchStart = args['search-start'];
  const outputPath = args.output;

  if (!searchStart) {
    throw new Error('Missing required --search-start argument');
  }

  if (!outputPath) {
    throw new Error('Missing required --output argument');
  }

  const { normalizedConfig, packageJsonPath } =
    resolveOtaPackageConfig(searchStart);

  if (format !== 'json' && format !== 'swift') {
    throw new Error(`Unsupported --format value: ${format}`);
  }

  const outputContents =
    format === 'swift'
      ? [
          'import Foundation',
          '',
          'enum RNOtaGeneratedConfig {',
          `  static let publicURLBaseString: String? = ${
            normalizedConfig.publicUrlBase
              ? JSON.stringify(normalizedConfig.publicUrlBase)
              : 'nil'
          }`,
          '}',
          '',
        ].join('\n')
      : `${JSON.stringify(normalizedConfig, null, 2)}\n`;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, outputContents);

  if (packageJsonPath) {
    console.log(
      `[react-native-ota] Wrote native config from ${packageJsonPath} to ${outputPath}`
    );
  } else {
    console.log(
      `[react-native-ota] No package.json found from ${searchStart}; wrote empty native config to ${outputPath}`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `[react-native-ota] ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
}
