const fs = require('fs');
const path = require('path');

describe('ReactNativeOta.podspec', () => {
  it('uses React Native xcode environment to resolve the node binary', () => {
    const podspec = fs.readFileSync(
      path.join(__dirname, '..', '..', 'ReactNativeOta.podspec'),
      'utf8'
    );
    const withEnvironmentIndex = podspec.indexOf(
      '. "$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"'
    );

    expect(podspec).toContain('set -e');
    expect(withEnvironmentIndex).toBeGreaterThan(-1);
    expect(podspec.indexOf('set -u')).toBeGreaterThan(withEnvironmentIndex);
    expect(podspec).toContain(
      '"$NODE_BINARY" "${PODS_TARGET_SRCROOT}/scripts/generate-ota-config.js"'
    );
    expect(podspec).not.toContain(
      'node "${PODS_TARGET_SRCROOT}/scripts/generate-ota-config.js"'
    );
  });
});
