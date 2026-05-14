# Contributing

Contributions are always welcome, no matter how large or small!

We want this community to be friendly and respectful to each other. Please follow it in all your interactions with the project. Before contributing, please read the [code of conduct](./CODE_OF_CONDUCT.md).

## Development setup

### Prerequisites

| Tool           | Notes                                                                           |
| -------------- | ------------------------------------------------------------------------------- |
| Node.js        | See [`.nvmrc`](./.nvmrc) for the exact version (`nvm use` or `fnm use`)         |
| Yarn 4         | Enabled via [Corepack](https://nodejs.org/api/corepack.html): `corepack enable` |
| Xcode          | Required for iOS builds and simulator interaction                               |
| Android Studio | Required for Android builds; create at least one AVD                            |
| CocoaPods      | Required for iOS native dependencies (`gem install cocoapods`)                  |
| `argent`       | iOS/Android simulator automation CLI — see [Install argent](#install-argent)    |

### Install dependencies

Run `yarn` in the root directory to install dependencies for the library and all workspaces under `examples/`:

```sh
yarn
```

> Since the project relies on Yarn workspaces, you cannot use [`npm`](https://github.com/npm/cli) for development without manually migrating.

After dependency changes that affect iOS:

```sh
cd examples/0.85/ios && pod install
```

### Install argent

`argent` is a CLI for iOS and Android simulator control. It is used by the E2E test runner (`yarn ota:test`) to launch the app and read the UI.

Install it globally:

```sh
npm install -g @swmansion/argent
```

With a simulator running and the example app installed, run a one-off verification:

```sh
# Get the UDID of the booted simulator
UDID=$(argent run list-devices --json | jq -r '[.devices[] | select(.platform=="ios" and .state=="Booted")][0].udid')

# Relaunch the app and read the UI
argent run restart-app --udid $UDID --bundleId imcsorin.reactnativeota.example
argent run describe --udid $UDID --json
```

## Development workflow

This project is a monorepo managed using [Yarn workspaces](https://yarnpkg.com/features/workspaces). It contains the following packages:

- The library package in the root directory.
- Example apps under `examples/`, one folder per React Native version (e.g. `examples/0.85/`).

The [example apps](/examples/) demonstrate usage of the library. You need to run one to test any changes you make.

It is configured to use the local version of the library, so any changes you make to the library's source code will be reflected in the example app. Changes to the library's JavaScript code will be reflected in the example app without a rebuild, but native code changes will require a rebuild of the example app.

If you want to use Android Studio or Xcode to edit the native code, you can open the `examples/0.85/android` or `examples/0.85/ios` directories respectively in those editors. To edit the Objective-C or Swift files, open `examples/0.85/ios/ReactNativeOtaExample.xcworkspace` in Xcode and find the source files at `Pods > Development Pods > @imcsorin/react-native-ota`.

To edit the Java or Kotlin files, open `examples/0.85/android` in Android studio and find the source files at `imcsorin-react-native-ota` under `Android`.

You can use various commands from the root directory to work with the project.

To start the packager:

```sh
yarn example start
```

To run the example app on Android:

```sh
yarn example android
```

To run the example app on iOS:

```sh
yarn example ios
```

To confirm that the app is running with the new architecture, you can check the Metro logs for a message like this:

```sh
Running "ReactNativeOtaExample" with {"fabric":true,"initialProps":{"concurrentRoot":true},"rootTag":1}
```

Note the `"fabric":true` and `"concurrentRoot":true` properties.

Make sure your code passes TypeScript:

```sh
yarn typecheck
```

To check for linting errors, run the following:

```sh
yarn lint
```

To fix formatting errors, run the following:

```sh
yarn lint --fix
```

Remember to add tests for your change if possible. Run the unit tests by:

```sh
yarn test
```

### Scripts

The `package.json` file contains various scripts for common tasks:

- `yarn`: setup project by installing dependencies.
- `yarn typecheck`: type-check files with TypeScript.
  - `yarn lint`: lint files with [ESLint](https://eslint.org/).
    - `yarn test`: run unit tests with [Jest](https://jestjs.io/).
  - `yarn example start`: start the Metro server for the example app.
- `yarn example android`: run the example app on Android.
- `yarn example ios`: run the example app on iOS.

## Local OTA server and E2E tests

The repo includes a minimal S3-compatible server (`server/`) and an end-to-end test suite (`e2e/`) for running the full OTA stack locally without an AWS account.

**Start the local server:**

```sh
yarn ota:serve
```

The server runs on port `31337`, binds to `0.0.0.0`, and stores uploads under `.ota-s3/`. Set `react-native-ota.publicUrlBase` in your example app's `package.json` (e.g. `examples/0.85/package.json`) to `http://<your-machine-ip>:31337/local-ota/demo` so a physical device can reach it.

**Publish to the local server:**

```sh
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_ENDPOINT=http://127.0.0.1:31337 \
AWS_PATH=local-ota/demo \
npx react-native-ota-release publish \
  --project-root examples/0.85 \
  --bundle-version 1024
```

**Run the E2E test suite** (requires a simulator or emulator, and `argent` installed):

```sh
yarn ota:test
yarn ota:test --platform ios
yarn ota:test --platform android
yarn ota:test --test ota-update,rollback-bad-update
yarn ota:test --list-tests
```

The runner exits `0` when all selected tests pass. See [e2e/README.md](e2e/README.md) for the full test list and file layout, and [server/README.md](server/README.md) for server internals.

### Commit message convention

We follow the [conventional commits specification](https://www.conventionalcommits.org/en) for our commit messages:

- `fix`: bug fixes, e.g. fix crash due to deprecated method.
- `feat`: new features, e.g. add new method to the module.
- `refactor`: code refactor, e.g. migrate from class components to hooks.
- `docs`: changes into documentation, e.g. add usage example for the module.
- `test`: adding or updating tests, e.g. add integration tests using detox.
- `chore`: tooling changes, e.g. change CI config.

Our pre-commit hooks verify that your commit message matches this format when committing.

### Publishing to npm

We use [release-it](https://github.com/release-it/release-it) to make it easier to publish new versions. It handles common tasks like bumping version based on semver, creating tags and releases etc.

To publish new versions, run the following:

```sh
yarn release
```

### Sending a pull request

> **Working on your first pull request?** You can learn how from this _free_ series: [How to Contribute to an Open Source Project on GitHub](https://app.egghead.io/playlists/how-to-contribute-to-an-open-source-project-on-github).

When you're sending a pull request:

- Prefer small pull requests focused on one change.
- Verify that linters and tests are passing.
- Review the documentation to make sure it looks good.
- Follow the pull request template when opening a pull request.
- For pull requests that change the API or implementation, discuss with maintainers first by opening an issue.
