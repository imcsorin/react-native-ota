# E2E Test Suite

End-to-end tests that exercise the full OTA stack together: the publish CLI builds and uploads to the real S3 server, and the native library on a simulator or emulator downloads and applies the update.

## File layout

```
e2e/
  run.mjs                       # entry point, arg parsing, test runner loop
  context.mjs                   # TestContext — device management, app install, publishRelease
  server.mjs                    # OtaTestServer — starts/stops server/ota-server.mjs
  assertions.mjs                # assertEqual, assertIncludes, assertMissing, parseUiAssertions
  utils.mjs                     # runCommand, sleep, incrementBinaryVersion, detectHostIp, …
  tests/
    index.mjs                   # testDefinitions registry
    fresh-install.mjs
    binary-version-mismatch.mjs
    ota-update.mjs
    lower-bundle-version.mjs
    rollback.mjs
```

## Run

```sh
yarn ota:test
```

```sh
yarn ota:test --platform ios
yarn ota:test --platform android
```

```sh
yarn ota:test --test fresh-install
yarn ota:test --test ota-update,rollback-bad-update
```

```sh
yarn ota:test --list-tests
```

The runner exits `0` when all selected tests pass and non-zero when any fail.
