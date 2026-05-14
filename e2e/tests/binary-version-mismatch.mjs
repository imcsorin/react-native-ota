import { assertEqual, assertIncludes, assertMissing, assertNotIncludes } from '../assertions.mjs';
import { incrementBinaryVersion } from '../utils.mjs';

export const definition = {
  id: 'binary-version-mismatch',
  title: 'Mismatched binary version manifest is ignored',
  run: runBinaryVersionMismatchTest,
};

async function runBinaryVersionMismatchTest(context) {
  // Publish with incremented binary versions so the manifest lands at the wrong
  // path. The app requests manifests/{platform}/{real-version}.json and gets 404.
  const mismatchedVersions = {
    ios: incrementBinaryVersion(context.binaryVersions.ios),
    android: incrementBinaryVersion(context.binaryVersions.android),
  };

  await context.publishRelease('good-2048', {
    binaryVersions: mismatchedVersions,
  });

  await context.runForEachPlatform(async (platform) => {
    context.log(`Running binary version mismatch test for ${platform}`);
    await context.reinstallFreshApp(platform);

    if (platform === 'ios') {
      const ui = await context.launchIosAndReadUi({
        expectedBundleLabel: 'embedded-v1',
      });
      assertEqual(ui.bundleLabel, 'embedded-v1', 'iOS binary mismatch bundle label');
      assertEqual(ui.expectedScenario, 'embedded-assets', 'iOS binary mismatch scenario');
      assertEqual(ui.overall, 'PASS', 'iOS binary mismatch overall state');
      const state = await context.readIosState();
      assertMissing(state.current, 'iOS binary mismatch current OTA bundle');
      assertEqual(state.currentPending, false, 'iOS binary mismatch pending flag');
      return;
    }

    const { logs, ui } = await context.launchAndroidAndReadUi({
      expectedBundleLabel: 'embedded-v1',
    });
    assertEqual(ui.bundleLabel, 'embedded-v1', 'Android binary mismatch bundle label');
    assertEqual(ui.expectedScenario, 'embedded-assets', 'Android binary mismatch scenario');
    assertEqual(ui.overall, 'PASS', 'Android binary mismatch overall state');
    assertIncludes(
      logs,
      `Checking for OTA update (binaryVersion=${context.binaryVersions.android}, current=embedded`,
      'Android binary mismatch update check log'
    );
    assertNotIncludes(
      logs,
      'Installing OTA archive for bundle 2048',
      'Android binary mismatch install absence'
    );
  });
}
