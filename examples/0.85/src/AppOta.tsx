import ReleaseVerificationScreen from './ReleaseVerificationScreen';

const { __OTA_BUNDLE_VERSION__: bundleVersion } = globalThis as {
  __OTA_BUNDLE_VERSION__?: number | string;
};

const otaBundleLabel =
  bundleVersion == null ? 'ota-update' : `ota-${String(bundleVersion)}`;

export default function AppOta() {
  return (
    <ReleaseVerificationScreen
      bundleLabel={otaBundleLabel}
      expectedScenario="ota-assets"
    />
  );
}
