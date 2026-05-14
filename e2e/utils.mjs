// Shared low-level utilities used across the e2e test infrastructure.
// Nothing here is test-specific — these are generic helpers for running
// shell commands, waiting, detecting the machine's IP address, etc.

import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ESM modules don't have __dirname by default, so we derive it from the
// current file's URL. repoRoot is one directory above the e2e/ folder.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Pauses execution for the given number of milliseconds.
// Used between steps that need the app to settle (e.g. after launching it).
export function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// Runs a shell command and returns its stdout, stderr, and exit code.
// Throws an error by default if the command exits with a non-zero code.
// Pass { allowFailure: true } for commands that are expected to sometimes fail
// (e.g. uninstalling an app that might not be installed yet).
export async function runCommand(command, args, options = {}) {
  const {
    allowFailure = false,
    cwd = repoRoot,
    env = process.env,
    onOutputLine = null,
  } = options;

  return new Promise((resolve, reject) => {
    // stdio: ['ignore', 'pipe', 'pipe'] means:
    //   - stdin  is closed (the command can't prompt for input)
    //   - stdout is captured into a string
    //   - stderr is captured into a string
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const handleOutput = (chunk, streamName) => {
      const text = chunk.toString();
      const lines = text.split(/\r?\n/);

      if (streamName === 'stdout') {
        stdout += text;
        lines[0] = `${stdoutBuffer}${lines[0]}`;
        stdoutBuffer = lines.pop() ?? '';
      } else {
        stderr += text;
        lines[0] = `${stderrBuffer}${lines[0]}`;
        stderrBuffer = lines.pop() ?? '';
      }

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.length > 0) {
          onOutputLine?.(trimmedLine);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      handleOutput(chunk, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      handleOutput(chunk, 'stderr');
    });

    // 'error' fires if the executable wasn't found or couldn't be spawned.
    child.once('error', reject);

    // 'close' fires after the process exits and all output has been flushed.
    child.once('close', (code) => {
      for (const line of [stdoutBuffer.trim(), stderrBuffer.trim()]) {
        if (line.length > 0) {
          onOutputLine?.(line);
        }
      }

      const result = {
        code: code ?? 0,
        stderr,
        stdout,
      };

      if (result.code !== 0 && !allowFailure) {
        // Include the command and any captured output so debugging is easy.
        reject(
          new Error(
            [
              `Command failed: ${command} ${args.join(' ')}`,
              stdout.trim(),
              stderr.trim(),
            ]
              .filter(Boolean)
              .join('\n')
          )
        );
        return;
      }

      resolve(result);
    });
  });
}

// Finds a usable JAVA_HOME on macOS when the current shell does not already
// export one. This makes Android builds work in non-interactive shells where
// Homebrew's OpenJDK is installed but not linked into the default PATH.
export async function findJavaHome() {
  const candidates = [
    process.env.JAVA_HOME,
    '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home',
    '/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(path.join(candidate, 'bin', 'java'), fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

// Starts a process in the background and returns immediately — we don't wait
// for it or capture its output. Used to start the Android emulator, which
// keeps running in the background for the duration of the tests.
export function startDetachedProcess(command, args) {
  const child = spawn(command, args, {
    detached: true,
    // 'ignore' on all three streams so the child is fully independent.
    stdio: 'ignore',
  });

  // unref() lets Node.js exit even if this child process is still running.
  child.unref();
}

// Converts an Error object (or any thrown value) into a plain string.
// Useful when logging failures — some thrown values aren't Error instances.
export function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

// Converts a kebab-case CLI flag name (e.g. "host-ip") into camelCase
// ("hostIp") so it can be stored as a JS object key.
export function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

// Bumps the last numeric segment of a semver-style version string by one.
// For example: "1.2.3" → "1.2.4", "1.0" → "1.1", "1.0.alpha" → "1.0.alpha-next".
// Used in the binary-version-mismatch test to publish a bundle that is
// intentionally associated with a different binary version than the installed app.
export function incrementBinaryVersion(version) {
  const parts = version.split('.');
  const lastIndex = parts.length - 1;
  const lastPart = Number(parts[lastIndex]);

  if (Number.isFinite(lastPart)) {
    parts[lastIndex] = String(lastPart + 1);
    return parts.join('.');
  }

  // If the last segment isn't a plain number, append "-next" as a fallback.
  return `${version}-next`;
}

// Finds the machine's non-loopback IPv4 address (e.g. "192.168.1.42").
// The OTA server is started on this address so that the iOS simulator and
// Android emulator — which run as separate network peers — can reach it.
// Loopback (127.0.0.1) is excluded because it only works within the host.
export function detectHostIp() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal === false) {
        return entry.address;
      }
    }
  }

  throw new Error(
    'Failed to detect a non-loopback IPv4 address. Pass --host-ip explicitly.'
  );
}
