# OTA Server

A minimal S3-compatible HTTP server used as a local upload target during development. It stores objects on disk and serves them back, giving the `react-native-ota-release` CLI a real S3 endpoint to publish to without requiring an AWS account or real infrastructure.

## Why this exists

The release CLI (`react-native-ota-release publish`) uploads OTA manifests and bundle zips to an S3-compatible endpoint. In production that endpoint is a real S3 bucket behind a CDN. Locally you need the same API contract so you can run the full publish flow end-to-end and have a physical device or simulator fetch the update from your machine.

This server provides that. It speaks enough of the S3 API (PUT object, GET object, HEAD object) for the CLI to work. The device fetches manifests and zips from it over plain HTTP using a local-network URL.

## Usage

Start the server from the repo root:

```sh
yarn ota:serve
```

The server starts on port `31337`, binds to `0.0.0.0`, clears its storage directory, and prints all local-network addresses so you know which URL to put in the example app's `package.json` as `react-native-ota.publicUrlBase`.

### Publishing to the local server

Run `react-native-ota-release publish` from the example app directory with the local server's S3 environment variables:

```sh
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
AWS_ENDPOINT=http://127.0.0.1:31337 \
AWS_PATH=local-ota/demo \
react-native-ota-release publish --bundle-version 20260509001
```

The CLI will build the OTA bundles, generate manifests, and PUT everything into the server. The server stores it under `.ota-s3/` in the repo root. A device configured with the matching `publicUrlBase` will then fetch the manifest and download the update.

## CLI flags

| Flag             | Default   | Description                                             |
| ---------------- | --------- | ------------------------------------------------------- |
| `--port`         | `31337`   | Port to listen on                                       |
| `--host`         | `0.0.0.0` | Address to bind                                         |
| `--storage-root` | `.ota-s3` | Directory to store uploaded objects (resolved from cwd) |

## API

| Method | Path              | Description                                       |
| ------ | ----------------- | ------------------------------------------------- |
| `GET`  | `/healthz`        | Returns `{"ok":true}`                             |
| `PUT`  | `/<bucket>/<key>` | Store an object at `<storageRoot>/<bucket>/<key>` |
| `GET`  | `/<bucket>/<key>` | Retrieve a stored object                          |
| `HEAD` | `/<bucket>/<key>` | Check existence and get content length            |

All other paths return 404. The server does not implement bucket creation, listing, or any other S3 operations.

## Adding to a new example app

No changes needed in the example app itself. The server runs at the repo root and is shared across all examples. Each example only needs the `AWS_*` environment variables and a matching `react-native-ota.publicUrlBase` in its `package.json` when publishing.

## Storage

Uploaded objects are stored under `.ota-s3/` at the repo root (gitignored). The layout mirrors the S3 path: `PUT /my-bucket/path/to/object.json` writes to `.ota-s3/my-bucket/path/to/object.json`.

The storage directory is deleted and recreated every time the server starts, so stale local releases are never shared across server sessions.
