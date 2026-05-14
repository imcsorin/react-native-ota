# @imcsorin/react-native-ota

Native-first OTA updates for React Native apps.

The package gives you two pieces:

- a native OTA runtime for **iOS** and **Android**
- a release CLI, `react-native-ota-release`, that builds and publishes OTA bundles

## How it works

The update flow is entirely native — there is no public JS API and no JS bootstrap call required.

On launch the native runtime picks the best available bundle (OTA or embedded) for React Native to load, then concurrently checks for a newer bundle by fetching a JSON manifest from your CDN. If the manifest has a strictly newer `bundleVersion`, the runtime downloads the zip, extracts it, reloads React Native, and marks the new bundle as **pending**.

A bundle stays pending until React renders content and a 3-second grace period passes — at that point it is **confirmed**. If the app crashes before confirmation, the next launch finds `currentPending=true` in persisted state and **rolls back** to the previous bundle automatically. A bad OTA can never brick the app: worst case is two silent crashes, then a clean rollback.

**Bundle selection priority on startup:**

1. Confirmed current OTA bundle
2. Previous OTA bundle (if current is missing or corrupted)
3. Embedded bundle shipped with the binary

**`binaryVersion` scoping:** The manifest URL includes the native app version (`CFBundleShortVersionString` on iOS, `versionName` on Android). This scopes OTA updates to a specific binary — a bundle built for v1.2 is never applied to a v1.3 binary.

## Install

Install the package in your React Native app:

```sh
npm install @imcsorin/react-native-ota
```

Or let the CLI add the package, patch the native host files, and run CocoaPods:

```sh
npx react-native-ota-release install \
  --public-url-base https://cdn.example.com/mobile/prod
```

If your app uses iOS, install pods after adding the package:

```sh
cd ios && pod install
```

React Native autolinking handles native module registration. The only manual step is wiring the native startup — or letting `install` do it for you.

The install command automates startup wiring for the current React Native Swift/Kotlin host templates by updating:

- `ios/**/AppDelegate.swift`
- `android/app/src/main/java/**/MainApplication.kt`

## Enable OTA in your app

### 1. Configure the public OTA URL base in your app `package.json`

This is the only supported configuration surface. Do **not** add OTA config to `Info.plist` or `AndroidManifest.xml`.

```json
{
  "react-native-ota": {
    "publicUrlBase": "https://cdn.example.com/mobile/prod"
  }
}
```

The native runtime reads this from a build artifact generated from your `package.json` at build time, then fetches the platform manifest at:

```text
<publicUrlBase>/manifests/<platform>/<binaryVersion>.json
```

### 2. Wire the native startup flow

#### iOS

Add the import and override `bundleURL()` in your `RCTDefaultReactNativeFactoryDelegate` subclass:

```swift
import ReactNativeOta
...
override func bundleURL() -> URL? {
#if DEBUG
  RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
  RNOtaManager.shared.bundleURL()
#endif
}
```

`bundleURL()` restores persisted OTA state, starts the background update check, and returns the URL for React Native to load.

#### Android

Add the import and override `getJSBundleFile()` inside your `DefaultReactNativeHost`. Pass the `invalidateReactHost` lambda so the controller can clear the cached `ReactHost` before reloading:

```kt
import com.imcsorin.reactnativeota.ReactNativeOtaController
...
override fun getJSBundleFile(): String? =
  ReactNativeOtaController.getJSBundleFile(this@MainApplication) {
    reactNativeHost.clear()
    currentReactHost = null
  }
```

### Manifest format

The manifest is a JSON file your CDN serves at `<publicUrlBase>/manifests/<platform>/<binaryVersion>.json`. The runtime only installs the bundle when `bundleVersion` is a non-negative integer strictly newer than whatever is currently running.

```json
{
  "bundleVersion": 1024,
  "downloadUrl": "https://cdn.example.com/mobile/prod/updates/1024/ios.zip"
}
```

Missing, malformed, or not-newer manifests are silently ignored.

**Archive layout:**

- **iOS:** `main.jsbundle` at the zip root plus bundled assets
- **Android:** `index.android.bundle` at the zip root plus bundled assets

## Create a new release

Run the release CLI from your React Native app root:

```sh
export AWS_ACCESS_KEY_ID=<aws-access-key-id>
export AWS_SECRET_ACCESS_KEY=<aws-secret-access-key>
export AWS_ENDPOINT=https://s3.example.com
export AWS_PATH=my-bucket/mobile/prod

npx react-native-ota-release publish \
  --bundle-version 1024
```

By default the CLI:

- builds release bundles for **iOS** and **Android**
- writes local artifacts to `.react-native-ota/<bundleVersion>/`
- uploads `manifests/ios/<iosBinaryVersion>.json`
- uploads `manifests/android/<androidBinaryVersion>.json`
- uploads `updates/<bundleVersion>/ios.zip`
- uploads `updates/<bundleVersion>/android.zip`

If you omit `--bundle-version`, the CLI generates a timestamp-derived integer.

The CLI reads `react-native-ota.publicUrlBase` from your app `package.json` to construct download URLs in the manifest.

## Install options

```sh
npx react-native-ota-release install [options]
```

| Flag                                          | Description                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| `--project-root <path>`                       | React Native app root to patch.                                             |
| `--platform <all\|ios\|android\|ios,android>` | Patch one or both native platforms. Default is `all`.                       |
| `--public-url-base <url>`                     | Writes `react-native-ota.publicUrlBase` into your app `package.json`.       |
| `--package-manager <npm\|yarn\|pnpm\|bun>`    | Override package manager auto-detection.                                    |
| `--skip-package-install`                      | Only patch native files and `package.json`; do not run the package manager. |
| `--skip-pods`                                 | Skip `pod install` after patching iOS.                                      |

## Release options

### CLI flags

| Flag                                          | Description                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--bundle-version <value>`                    | Explicit OTA bundle version as an integer. If omitted, a timestamp-derived integer is generated. |
| `--platform <all\|ios\|android\|ios,android>` | Build one or both platforms. Default is `all`.                                                   |
| `--project-root <path>`                       | React Native app root to bundle from.                                                            |
| `--entry-file <path>`                         | Override the React Native entry file.                                                            |
| `--metro-config <path>`                       | Override the Metro config path.                                                                  |
| `--ios-binary-version <value>`                | Override detected iOS app version.                                                               |
| `--android-binary-version <value>`            | Override detected Android app version.                                                           |
| `--output-dir <path>`                         | Write local artifacts somewhere other than `.react-native-ota/`.                                 |
| `--dry-run`                                   | Build artifacts and print the manifest/upload plan without uploading.                            |

### Environment variables

| Variable                | Required | Description                                                                                 |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `AWS_ENDPOINT`          | Yes      | S3 or S3-compatible endpoint, such as `https://s3.example.com` or `http://127.0.0.1:31337`. |
| `AWS_PATH`              | Yes      | Upload destination in `bucket/prefix` form, such as `my-bucket/mobile/prod`.                |
| `AWS_ACCESS_KEY_ID`     | Yes      | AWS access key.                                                                             |
| `AWS_SECRET_ACCESS_KEY` | Yes      | AWS secret key.                                                                             |

The CLI fails fast when required environment variables are missing.

## Contributing

- [Development setup](CONTRIBUTING.md#development-setup)
- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Local OTA server and E2E tests](CONTRIBUTING.md#local-ota-server-and-e2e-tests)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT
