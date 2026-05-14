import { assertEqual, assertIncludes } from '../assertions.mjs';

export const definition = {
  id: 'lower-bundle-version',
  title: 'Lower OTA bundle version is ignored',
  run: runLowerBundleVersionIgnoredTest,
};

async function runLowerBundleVersionIgnoredTest(context) {
  // Step 1: fresh install + apply good-2048 on both platforms in parallel.
  await context.runForEachPlatform(async (platform) => {
    context.log(`Running lower bundle version rejection test for ${platform}`);
    await context.reinstallFreshApp(platform);
  });

  await context.publishRelease('good-2048');

  await context.runForEachPlatform(async (platform) => {
    if (platform === 'ios') {
      const ui = await context.launchIosAndReadUi({
        expectedBundleLabel: 'ota-2048',
        expectedBundleVersion: '2048',
      });
      assertEqual(ui.bundleLabel, 'ota-2048', 'iOS lower-version setup bundle label');
      return;
    }

    const result = await context.launchAndroidAndReadUi({
      expectedBundleLabel: 'ota-2048',
    });
    assertEqual(result.ui.bundleLabel, 'ota-2048', 'Android lower-version setup bundle label');
  });

  // Step 2: publish good-1024 (lower version) and verify it is ignored.
  await context.publishRelease('good-1024');

  await context.runForEachPlatform(async (platform) => {
    if (platform === 'ios') {
      const ui = await context.launchIosAndReadUi({
        expectedBundleLabel: 'ota-2048',
      });
      assertEqual(ui.bundleLabel, 'ota-2048', 'iOS lower-version retained bundle label');
      assertEqual(ui.expectedScenario, 'ota-assets', 'iOS lower-version scenario');
      assertEqual(ui.overall, 'PASS', 'iOS lower-version overall state');
      const state = await context.readIosState();
      assertEqual(state.current?.bundleVersion, '2048', 'iOS lower-version persisted bundle version');
      assertEqual(state.currentPending, false, 'iOS lower-version pending flag');
      return;
    }

    const logs = await context.triggerAndroidLaunchAndReadLogs();
    assertIncludes(
      logs,
      'Ignoring manifest entry because bundleVersion 1024 is not newer than current 2048',
      'Android lower-version ignore log'
    );
    const result = await context.launchAndroidAndReadUi({
      expectedBundleLabel: 'ota-2048',
    });
    assertEqual(result.ui.bundleLabel, 'ota-2048', 'Android lower-version retained bundle label');
    assertEqual(result.ui.expectedScenario, 'ota-assets', 'Android lower-version scenario');
    assertEqual(result.ui.overall, 'PASS', 'Android lower-version overall state');
  });
}
