#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';

const defaultPort = 31337;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const port = Number(options.port ?? defaultPort);
  const host = options.host ?? '0.0.0.0';
  const storageRoot = path.resolve(options.storageRoot ?? '.ota-s3');

  await rm(storageRoot, { force: true, recursive: true });
  await mkdir(storageRoot, { recursive: true });

  const server = createServer(async (request, response) => {
    try {
      if (request.url == null) {
        respondJson(response, 400, { error: 'Missing request URL' });
        return;
      }

      const requestUrl = new URL(
        request.url,
        `http://${request.headers.host ?? 'localhost'}`
      );
      const pathname = requestUrl.pathname;
      console.log(
        `[ota-server] ${request.method ?? 'GET'} ${pathname} host=${request.headers.host ?? 'unknown'}`
      );

      if (pathname === '/healthz') {
        respondJson(response, 200, { ok: true });
        return;
      }

      const objectRequest = parseObjectRequest(pathname);

      if (objectRequest != null) {
        try {
          if (request.method === 'PUT') {
            await handlePutObject(
              request,
              response,
              objectRequest,
              storageRoot
            );
            return;
          }

          if (request.method === 'GET' || request.method === 'HEAD') {
            await handleReadObject(
              response,
              request.method,
              objectRequest,
              storageRoot
            );
            return;
          }
        } catch (error) {
          if (isNotFoundError(error)) {
            respondJson(response, 404, { error: 'Object not found' });
            return;
          }

          throw error;
        }
      }

      respondJson(response, 404, { error: 'Not found' });
    } catch (error) {
      respondJson(response, 500, {
        error:
          error instanceof Error ? error.message : 'Unknown server failure',
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const endpoint = `http://127.0.0.1:${port}`;

  console.log(`OTA S3 server ready on http://${host}:${port}`);
  console.log(`Storage root: ${storageRoot}`);
  console.log('Storage root cleaned on startup');
  console.log(`Endpoint: ${endpoint}`);

  for (const localUrl of buildLocalNetworkUrls(port)) {
    console.log(`Local network endpoint: ${localUrl}`);
  }
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    if (!current.startsWith('--')) {
      continue;
    }

    const optionName = normalizeOptionName(current.slice(2));
    const optionValue = argv[index + 1];

    if (optionValue == null || optionValue.startsWith('--')) {
      throw new Error(`Missing value for --${optionName}`);
    }

    options[optionName] = optionValue;
    index += 1;
  }

  return options;
}

function buildLocalNetworkUrls(port) {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (entry) => entry?.family === 'IPv4' && entry.address !== '127.0.0.1'
    )
    .map((entry) => `http://${entry.address}:${port}`);
}

function contentTypeForPath(filePath) {
  if (filePath.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }

  if (filePath.endsWith('.zip')) {
    return 'application/zip';
  }

  return 'application/octet-stream';
}

async function handlePutObject(request, response, objectRequest, storageRoot) {
  const { filePath } = resolveObjectPath(objectRequest, storageRoot);
  const tempPath = `${filePath}.upload-${process.pid}-${Date.now()}`;

  await mkdir(path.dirname(filePath), { recursive: true });

  try {
    await pipeline(request, createWriteStream(tempPath));
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }

  response.writeHead(200, {
    ETag: `"local-${Date.now()}"`,
  });
  response.end();
}

async function handleReadObject(response, method, objectRequest, storageRoot) {
  const { filePath } = resolveObjectPath(objectRequest, storageRoot);
  const fileStats = await stat(filePath);
  const headers = {
    'Content-Length': fileStats.size,
    'Content-Type': contentTypeForPath(filePath),
  };

  if (method === 'HEAD') {
    response.writeHead(200, headers);
    response.end();
    return;
  }

  response.writeHead(200, headers);

  try {
    await pipeline(createReadStream(filePath), response);
  } catch {
    // Client disconnected mid-transfer; nothing actionable
  }
}

function parseObjectRequest(pathname) {
  const trimmedPath = pathname.replace(/^\/+|\/+$/g, '');

  if (trimmedPath.length === 0) {
    return null;
  }

  const [bucket, ...keyParts] = trimmedPath.split('/');

  if (keyParts.length === 0) {
    return null;
  }

  return {
    bucket: decodeURIComponent(bucket),
    key: keyParts.map((segment) => decodeURIComponent(segment)).join('/'),
  };
}

function resolveObjectPath({ bucket, key }, storageRoot) {
  const resolvedRoot = path.resolve(storageRoot);
  const bucketRoot = path.resolve(storageRoot, bucket);
  const filePath = path.resolve(bucketRoot, key);

  if (
    bucketRoot === resolvedRoot ||
    !bucketRoot.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error('Invalid bucket name');
  }

  if (!filePath.startsWith(`${bucketRoot}${path.sep}`)) {
    throw new Error('Invalid object key');
  }

  return { bucketRoot, filePath };
}

function isNotFoundError(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function respondJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function normalizeOptionName(value) {
  return value.replace(/-([a-z])/g, (_match, character) =>
    character.toUpperCase()
  );
}

await main();
