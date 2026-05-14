import { assertEqual, assertIncludes, assertMissing } from '../assertions.mjs';

export const definition = {
  id: 'fresh-install',
  title: 'Fresh install uses embedded bundle',
  run: runFreshInstallTest,
};

// No publishRelease call — the server has no manifests uploaded yet, so
// the app receives 404 and falls back to the embedded bundle.
async function runFreshInstallTest(context) {
  await context.runForEachPlatform(async (platform) => {
    context.log(`Running fresh install baseline for ${platform}`);
    await context.reinstallFreshApp(platform);

    if (platform === 'ios') {
      const ui = await context.launchIosAndReadUi({
        expectedBundleLabel: 'embedded-v1',
      });
      assertEqual(ui.bundleLabel, 'embedded-v1', 'iOS fresh install bundle label');
      assertEqual(ui.expectedScenario, 'embedded-assets', 'iOS fresh install scenario');
      assertEqual(ui.overall, 'PASS', 'iOS fresh install overall state');
      const state = await context.readIosState();
      assertEqual(state.currentPending, false, 'iOS fresh install pending flag');
      assertMissing(state.current, 'iOS fresh install current OTA bundle');
      return;
    }

    const { logs, ui } = await context.launchAndroidAndReadUi({
      expectedBundleLabel: 'embedded-v1',
    });
    assertEqual(ui.bundleLabel, 'embedded-v1', 'Android fresh install bundle label');
    assertEqual(ui.expectedScenario, 'embedded-assets', 'Android fresh install scenario');
    assertEqual(ui.overall, 'PASS', 'Android fresh install overall state');
    assertIncludes(
      logs,
      'Persisted OTA state (current=embedded, previous=none, pending=false)',
      'Android fresh install persisted state'
    );
  });
}
