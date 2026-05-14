import { assertEqual, assertIncludes, assertNotIncludes } from '../assertions.mjs';

export const definition = {
  id: 'rollback-bad-update',
  title: 'Bad OTA update rolls back',
  run: runRollbackTest,
};

async function runRollbackTest(context) {
  // Step 1: fresh install on both platforms in parallel.
  await context.runForEachPlatform(async (platform) => {
    context.log(`Running rollback OTA test for ${platform}`);
    await context.reinstallFreshApp(platform);
  });

  // Step 2: publish good-2048 and verify it applies on both platforms.
  await context.publishRelease('good-2048');

  await context.runForEachPlatform(async (platform) => {
    if (platform === 'ios') {
      const ui = await context.launchIosAndReadUi({
        expectedBundleLabel: 'ota-2048',
        expectedBundleVersion: '2048',
      });
      assertEqual(ui.bundleLabel, 'ota-2048', 'iOS rollback setup bundle label');
      return;
    }

    const result = await context.launchAndroidAndReadUi({
      expectedBundleLabel: 'ota-2048',
    });
    assertEqual(result.ui.bundleLabel, 'ota-2048', 'Android rollback setup bundle label');
  });

  // Step 3: publish bad-4096 and trigger the crash on both platforms.
  await context.publishRelease('bad-4096');

  await context.runForEachPlatform(async (platform) => {
    if (platform === 'ios') {
      await context.triggerIosLaunch();
      const state = await context.readIosState();
      assertEqual(state.current?.bundleVersion, '4096', 'iOS bad OTA pending bundle version');
      assertEqual(state.currentPending, true, 'iOS bad OTA pending flag');
      return;
    }

    const logs = await context.triggerAndroidLaunchAndReadLogs();
    assertIncludes(logs, 'Installing OTA archive for bundle 4096', 'Android bad OTA install log');
    assertIncludes(
      logs,
      'Persisted OTA state (current=4096, previous=2048, pending=true)',
      'Android bad OTA pending state'
    );
    assertNotIncludes(logs, 'Confirmed OTA bundle 4096', 'Android bad OTA confirm absence');
  });

  // Step 4: verify both platforms recover by rolling back to the locally cached
  // good-2048 bundle — no new server publish required. The server is stopped so
  // the background update check cannot re-download bad-4096 (which is still the
  // latest manifest entry) and overwrite the just-restored state.
  await context.server.stop();

  await context.runForEachPlatform(async (platform) => {
    if (platform === 'ios') {
      const ui = await context.launchIosAndReadUi({
        expectedBundleLabel: 'ota-2048',
        expectedBundleVersion: '2048',
      });
      assertEqual(ui.bundleLabel, 'ota-2048', 'iOS rollback recovered bundle label');
      assertEqual(ui.expectedScenario, 'ota-assets', 'iOS rollback scenario');
      assertEqual(ui.overall, 'PASS', 'iOS rollback overall state');
      const state = await context.readIosState();
      assertEqual(state.current?.bundleVersion, '2048', 'iOS rollback persisted bundle version');
      assertEqual(state.currentPending, false, 'iOS rollback pending flag');
      return;
    }

    const rollbackLogs = await context.triggerAndroidLaunchAndReadLogs();
    assertIncludes(rollbackLogs, 'Rolling back pending OTA bundle 4096', 'Android rollback log');
    const result = await context.launchAndroidAndReadUi({
      expectedBundleLabel: 'ota-2048',
    });
    assertEqual(result.ui.bundleLabel, 'ota-2048', 'Android rollback recovered bundle label');
    assertEqual(result.ui.expectedScenario, 'ota-assets', 'Android rollback scenario');
    assertEqual(result.ui.overall, 'PASS', 'Android rollback overall state');
  });
}
