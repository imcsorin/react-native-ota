import { definition as binaryVersionMismatch } from './binary-version-mismatch.mjs';
import { definition as freshInstall } from './fresh-install.mjs';
import { definition as lowerBundleVersion } from './lower-bundle-version.mjs';
import { definition as otaUpdate } from './ota-update.mjs';
import { definition as rollback } from './rollback.mjs';

export const testDefinitions = [
  freshInstall,
  binaryVersionMismatch,
  otaUpdate,
  lowerBundleVersion,
  rollback,
];
