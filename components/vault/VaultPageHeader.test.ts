import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./VaultPageHeader.tsx", import.meta.url), "utf8");
const keychainSource = readFileSync(new URL("../KeychainManager.tsx", import.meta.url), "utf8");
const knownHostsSource = readFileSync(new URL("../KnownHostsManager.tsx", import.meta.url), "utf8");
const portForwardingSource = readFileSync(new URL("../PortForwardingNew.tsx", import.meta.url), "utf8");

test("vault page headers wrap their actions instead of clipping them on narrow windows", () => {
  // Half-screen tiling can hand the content a ~520px-wide surface. The fixed
  // action buttons must move to a second row there instead of being cut off
  // by the window edge.
  assert.match(source, /min-h-14[^"]*flex-wrap/);
  assert.match(source, /gap-y-2/);
  assert.doesNotMatch(source, /"h-14 px-4 py-2 flex items-center gap-3 app-no-drag"/);
});

test("nested VaultPageHeader action groups wrap so controls stay visible at narrow half-screen widths", () => {
  const keychainHeader = keychainSource.match(/<VaultPageHeader>[\s\S]*?<\/VaultPageHeader>/)?.[0] ?? "";
  assert.ok(keychainHeader, "expected VaultPageHeader in KeychainManager.tsx");
  assert.match(
    keychainHeader,
    /Action buttons: New Key \(split\) \| Import Certificate \| New Identity[\s\S]*?<div className="[^"]*flex-wrap[^"]*">/,
  );

  const knownHostsHeader = knownHostsSource.match(/<VaultPageHeader>[\s\S]*?<\/VaultPageHeader>/)?.[0] ?? "";
  assert.ok(knownHostsHeader, "expected VaultPageHeader in KnownHostsManager.tsx");
  assert.match(
    knownHostsHeader,
    /<div className="[^"]*flex-wrap[^"]*">\s*<Button[\s\S]*?knownHosts\.action\.scanSystem/,
  );

  const portForwardingHeader = portForwardingSource.match(/<VaultPageHeader[^>]*>[\s\S]*?<\/VaultPageHeader>/)?.[0] ?? "";
  assert.ok(portForwardingHeader, "expected VaultPageHeader in PortForwardingNew.tsx");
  assert.match(
    portForwardingHeader,
    /<div className="[^"]*flex-wrap[^"]*min-w-0[^"]*">\s*<VaultHeaderSearch/,
  );
});
