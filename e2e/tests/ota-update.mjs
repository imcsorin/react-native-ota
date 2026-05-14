import { assertEqual, assertIncludes } from '../assertions.mjs';

export const definition = {
  id: 'ota-update',
  title: 'Fresh install applies OTA update',
  run: runSuccessfulUpdateTest,
};

async function runSuccessfulUpdateTest(context) {
  await context.publishRelease('good-2048');

  await context.runForEachPlatform(async (platform) => {
    context.log(`Running successful OTA update test for ${platform}`);
    await context.reinstallFreshApp(platform);

    if (platform === 'ios') {
      const ui = await context.launchIosAndReadUi({
        expectedBundleLabel: 'ota-2048',
        expectedBundleVersion: '2048',
      });
      assertEqual(ui.bundleLabel, 'ota-2048', 'iOS OTA bundle label');
      assertEqual(ui.expectedScenario, 'ota-assets', 'iOS OTA scenario');
      assertEqual(ui.overall, 'PASS', 'iOS OTA overall state');
      const state = await context.waitForIosState({
        description: 'iOS OTA confirmation',
        predicate: (currentState) =>
          currentState.current?.bundleVersion === '2048' &&
          currentState.currentPending === false,
      });
      assertEqual(state.current?.bundleVersion, '2048', 'iOS OTA persisted bundle version');
      assertEqual(state.currentPending, false, 'iOS OTA pending flag');
      return;
    }

    const { ui } = await context.launchAndroidAndReadUi({
      expectedBundleLabel: 'ota-2048',
    });
    assertEqual(ui.bundleLabel, 'ota-2048', 'Android OTA bundle label');
    assertEqual(ui.expectedScenario, 'ota-assets', 'Android OTA scenario');
    assertEqual(ui.overall, 'PASS', 'Android OTA overall state');
    // Confirmation is delayed by a 3-second grace period after content appears,
    // so wait explicitly for that log rather than relying on the UI-settled sentinel.
    const logs = await context.waitForAndroidLog('Confirmed OTA bundle 2048');
    assertIncludes(logs, 'Installing OTA archive for bundle 2048', 'Android OTA install log');
    assertIncludes(logs, 'Confirmed OTA bundle 2048', 'Android OTA confirm log');
  });
}
