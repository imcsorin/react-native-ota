// Assertion helpers used inside test cases.
//
// Each function checks one condition and throws a descriptive Error if it
// fails. Throwing stops the test immediately and the error message is printed
// in the summary — so keep the messages clear enough to diagnose without
// needing to re-run the test.

// Checks that `actual` and `expected` are exactly equal (===).
// `label` describes what is being compared, e.g. "iOS OTA bundle label".
export function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected "${expected}" but received "${actual}"`);
  }
}

// Checks that `text` contains `expectedSubstring` somewhere inside it.
// Used to assert that a specific log line appeared in the device output.
export function assertIncludes(text, expectedSubstring, label) {
  if (!text.includes(expectedSubstring)) {
    throw new Error(`${label} missing expected substring: ${expectedSubstring}`);
  }
}

// Checks that `text` does NOT contain `unexpectedSubstring`.
// Used to confirm an action did NOT happen (e.g. a bundle was not installed).
export function assertNotIncludes(text, unexpectedSubstring, label) {
  if (text.includes(unexpectedSubstring)) {
    throw new Error(`${label} unexpectedly contained: ${unexpectedSubstring}`);
  }
}

// Checks that `value` is null or undefined (i.e. absent).
// Used to confirm there is no current OTA bundle on a fresh install.
export function assertMissing(value, label) {
  if (value != null) {
    throw new Error(`${label} expected to be missing but was ${JSON.stringify(value)}`);
  }
}

// Parses the text snapshot from a device's UI and extracts the three fields
// the example app renders on screen:
//   - bundleLabel:      which bundle is running (e.g. "embedded-v1", "ota-2048")
//   - expectedScenario: what assets the bundle expects (e.g. "embedded-assets")
//   - overall:          "PASS" or "FAIL" depending on whether assets matched
//
// The snapshot comes from `xcrun simctl` on iOS or `uiautomator dump` on
// Android, so it's raw text — we extract values with simple regexes.
export function parseUiAssertions(text) {
  return {
    bundleLabel: matchCapture(text, /Bundle label: ([^\n"]+)/),
    expectedScenario: matchCapture(text, /Expected scenario: ([^\n"]+)/),
    overall: matchCapture(text, /Overall: ([^\n"]+)/),
  };
}

// Runs a regex on `text`, trims the first capture group, and returns it.
// Throws if the pattern isn't found so failures are obvious.
function matchCapture(text, pattern) {
  const match = text.match(pattern);

  if (match == null) {
    throw new Error(`Did not find expected text with pattern ${pattern}`);
  }

  return match[1].trim();
}
