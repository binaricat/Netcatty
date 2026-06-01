import test from "node:test";
import assert from "node:assert/strict";

import {
  registerConnectionToken,
  runDistroDetection,
} from "./terminalDistroDetection.ts";

test("runDistroDetection skips POSIX probes for manually marked network devices", async () => {
  let remoteInfoCalls = 0;
  let distroProbeCalls = 0;
  const token = registerConnectionToken("ssh-session");

  await runDistroDetection({
    host: {
      id: "host-1",
      label: "Ruijie AP",
      hostname: "192.168.2.2",
      username: "root",
      deviceType: "network",
    },
    terminalBackend: {
      getSessionRemoteInfo: async () => {
        remoteInfoCalls += 1;
        return { success: true, remoteSshVersion: "RGOS_SSH" };
      },
      getSessionDistroInfo: async () => {
        distroProbeCalls += 1;
        return { success: false, error: "network device closed the extra channel" };
      },
    },
  } as never, "ssh-session", token);

  assert.equal(remoteInfoCalls, 0);
  assert.equal(distroProbeCalls, 0);
});
