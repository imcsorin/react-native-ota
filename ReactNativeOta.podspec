require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "ReactNativeOta"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/imcsorin/react-native-ota.git", :tag => "#{s.version}" }

  s.source_files = "ios/**/*.{h,m,mm,swift,cpp}"
  s.private_header_files = "ios/**/*.h"
  s.swift_version = "5.0"
  s.dependency "SSZipArchive", "2.4.3"
  s.script_phases = [
    {
      :name => "Generate React Native OTA config",
      :execution_position => :before_compile,
      :shell_path => "/bin/sh",
      :output_files => ["${PODS_TARGET_SRCROOT}/ios/ReactNativeOtaGeneratedConfig.swift"],
      :script => <<-SCRIPT
 set -e

. "$REACT_NATIVE_PATH/scripts/xcode/with-environment.sh"

set -u

SEARCH_START="${PROJECT_DIR:-${SRCROOT}}"
OUTPUT_PATH="${PODS_TARGET_SRCROOT}/ios/ReactNativeOtaGeneratedConfig.swift"

"$NODE_BINARY" "${PODS_TARGET_SRCROOT}/scripts/generate-ota-config.js" \
  --format swift \
  --search-start "${SEARCH_START}" \
  --output "${OUTPUT_PATH}"
SCRIPT
    }
  ]

  install_modules_dependencies(s)
end
