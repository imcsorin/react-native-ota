// Manages the lifecycle of the local OTA test server process.
//
// During tests we need a real HTTP server that behaves like S3 — the app
// fetches update manifests and downloads bundle ZIPs from it. Rather than
// mocking network calls inside the app, we run an actual server process
// (server/ota-server.mjs) on localhost and point the app at it.
//
// OtaTestServer spawns that script as a child process, waits until it's
// healthy, and provides a stop() method to cleanly shut it down afterward.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the standalone server script at the repo root.
const serverScript = path.join(__dirname, '..', 'server', 'ota-server.mjs');

export class OtaTestServer {
  // onLog  — function(message) called to log server events into the test output
  // port   — TCP port the server will listen on
  // storageRoot — directory where the server stores uploaded files (acts as the S3 bucket)
  constructor({ onLog, port, storageRoot }) {
    this.onLog = onLog;
    this.port = port;
    this.storageRoot = storageRoot;
    this.process = null;
  }

  // Spawns the server process and waits until its /healthz endpoint responds.
  // Calling start() twice is safe — it does nothing if already running.
  async start() {
    if (this.process != null) {
      return;
    }

    // stdio: ['ignore', 'inherit', 'inherit'] means:
    //   - stdin  is closed
    //   - stdout and stderr are forwarded directly to the parent's terminal
    //     so server logs appear interleaved with test output.
    this.process = spawn(process.execPath, [
      serverScript,
      '--port', String(this.port),
      '--storage-root', this.storageRoot,
    ], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    this.process.once('error', (error) => {
      this.onLog(`OTA server process error: ${error.message}`);
    });

    // The server needs a moment to bind its port before we send requests.
    await this.waitForHealthz();
    this.onLog(`Started OTA server on port ${this.port}`);
  }

  // Kills the server process and waits for it to fully exit.
  // Calling stop() when nothing is running is safe — it does nothing.
  async stop() {
    if (this.process == null) {
      return;
    }

    // Clear this.process first so any concurrent stop() call returns early.
    const proc = this.process;
    this.process = null;

    proc.kill();

    // Wait for the OS to confirm the process has exited before moving on,
    // so the next test (or the cleanup step) starts with a clean slate.
    await new Promise((resolve) => proc.once('close', resolve));
    this.onLog('Stopped OTA server');
  }

  // Polls the server's /healthz endpoint every 200 ms until it returns HTTP 200.
  // Gives up and throws after 10 seconds — if the server hasn't started by then,
  // something is wrong (wrong path, port already in use, etc.).
  async waitForHealthz() {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/healthz`);
        if (response.ok) {
          return;
        }
      } catch {
        // fetch() throws when the server isn't listening yet — keep retrying.
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`OTA server did not become healthy within 10s on port ${this.port}`);
  }
}
