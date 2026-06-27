import test from "node:test";
import assert from "node:assert/strict";

import { resolveSftpOpenLocation } from "./sftpReopenLocation.ts";

test("first open of a terminal lands on the terminal CWD", () => {
  const location = resolveSftpOpenLocation({
    hostId: "host-1",
    terminalCwd: "/home/deploy",
    remembered: null,
  });

  assert.equal(location, "/home/deploy");
});

test("re-opening the same terminal restores the last browsed path, not the terminal CWD", () => {
  // Repro: SFTP first opened at /home/deploy (terminal CWD), user navigated
  // into /home/deploy/projects/app, closed, then re-opened. The terminal shell
  // never moved, so terminalCwd is still /home/deploy — but the panel must
  // return to the folder the user was browsing.
  const location = resolveSftpOpenLocation({
    hostId: "host-1",
    terminalCwd: "/home/deploy",
    remembered: { hostId: "host-1", path: "/home/deploy/projects/app" },
  });

  assert.equal(location, "/home/deploy/projects/app");
});

test("remembered path for a different host is ignored in favour of the terminal CWD", () => {
  const location = resolveSftpOpenLocation({
    hostId: "host-2",
    terminalCwd: "/srv",
    remembered: { hostId: "host-1", path: "/home/deploy/projects/app" },
  });

  assert.equal(location, "/srv");
});

test("an empty remembered path falls back to the terminal CWD", () => {
  const location = resolveSftpOpenLocation({
    hostId: "host-1",
    terminalCwd: "/srv",
    remembered: { hostId: "host-1", path: "" },
  });

  assert.equal(location, "/srv");
});

test("no remembered path and no terminal CWD yields undefined", () => {
  assert.equal(
    resolveSftpOpenLocation({ hostId: "host-1", remembered: null }),
    undefined,
  );
  assert.equal(
    resolveSftpOpenLocation({ hostId: "host-1", terminalCwd: "", remembered: null }),
    undefined,
  );
});
