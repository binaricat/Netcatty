const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const helperSource = fs.readFileSync(
  path.join(__dirname, "windowsHelloHelper", "NetcattyWindowsHello.cpp"),
  "utf8",
);

test("Windows Hello helper uses desktop HWND interop", () => {
  assert.match(helperSource, /IUserConsentVerifierInterop/);
  assert.match(helperSource, /RequestVerificationForWindowAsync/);
  assert.match(helperSource, /--hwnd/);
  assert.doesNotMatch(helperSource, /UserConsentVerifier::RequestVerificationAsync/);
});

test("Windows Hello helper maps all expected verifier states", () => {
  for (const state of [
    "Available",
    "DeviceNotPresent",
    "NotConfiguredForUser",
    "DisabledByPolicy",
    "DeviceBusy",
    "RetriesExhausted",
    "Canceled",
    "Verified",
  ]) {
    assert.match(helperSource, new RegExp(state));
  }
});

test("Windows Hello helper uses a multi-threaded apartment for blocking waits", () => {
  assert.match(helperSource, /init_apartment\(winrt::apartment_type::multi_threaded\)/);
  assert.doesNotMatch(helperSource, /init_apartment\(winrt::apartment_type::single_threaded\)/);
});
