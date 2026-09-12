import test from "node:test";
import assert from "node:assert/strict";

import {
  registerConnectionToken,
  runDistroDetection,
} from "./terminalDistroDetection.ts";

test("runDistroDetection uses SSH banner but skips POSIX probes for manually marked network devices", async () => {
  let remoteInfoCalls = 0;
  let distroProbeCalls = 0;
  const detected: string[] = [];
  const token = registerConnectionToken("ssh-session");

  await runDistroDetection({
    host: {
      id: "host-1",
      label: "HPE iLO",
      hostname: "192.168.2.2",
      username: "root",
      deviceType: "network",
    },
    terminalBackend: {
      getSessionRemoteInfo: async () => {
        remoteInfoCalls += 1;
        return { success: true, remoteSshVersion: "SSH-2.0-mpSSH_0.2.1" };
      },
      getSessionDistroInfo: async () => {
        distroProbeCalls += 1;
        return { success: false, error: "network device closed the extra channel" };
      },
    },
    onOsDetected: (_hostId: string, distro: string) => {
      detected.push(distro);
    },
  } as never, "ssh-session", token);

  assert.equal(remoteInfoCalls, 1);
  assert.equal(distroProbeCalls, 0);
  assert.deepEqual(detected, ["hpe"]);
});

test("runDistroDetection normalizes Darwin probe output to macos", async () => {
  let remoteInfoCalls = 0;
  let distroProbeCalls = 0;
  const detected: string[] = [];
  const token = registerConnectionToken("macos-session");

  await runDistroDetection({
    host: {
      id: "macos-host",
      label: "Mac mini",
      hostname: "mac-mini.local",
      username: "dev",
    },
    terminalBackend: {
      getSessionRemoteInfo: async () => {
        remoteInfoCalls += 1;
        return { success: true, remoteSshVersion: "SSH-2.0-OpenSSH_9.9" };
      },
      getSessionDistroInfo: async () => {
        distroProbeCalls += 1;
        return {
          success: true,
          stdout: "Darwin mac-mini.local 24.5.0 Darwin Kernel Version 24.5.0\n",
          stderr: "",
        };
      },
    },
    onOsDetected: (_hostId: string, distro: string) => {
      detected.push(distro);
    },
  } as never, "macos-session", token);

  assert.equal(remoteInfoCalls, 1);
  assert.equal(distroProbeCalls, 1);
  assert.deepEqual(detected, ["macos"]);
});

test("runDistroDetection normalizes FreeBSD uname output", async () => {
  const detected: string[] = [];
  const token = registerConnectionToken("freebsd-session");

  await runDistroDetection({
    host: {
      id: "freebsd-host",
      label: "FreeBSD server",
      hostname: "freebsd.example.com",
      username: "root",
    },
    terminalBackend: {
      getSessionRemoteInfo: async () => ({
        success: true,
        remoteSshVersion: "SSH-2.0-OpenSSH_9.7 FreeBSD-20240806",
      }),
      getSessionDistroInfo: async () => ({
        success: true,
        stdout: "FreeBSD freebsd.example.com 14.3-RELEASE-p1 GENERIC amd64\n",
        stderr: "",
      }),
    },
    onOsDetected: (_hostId: string, distro: string) => {
      detected.push(distro);
    },
  } as never, "freebsd-session", token);

  assert.deepEqual(detected, ["freebsd"]);
});

test("Windows OpenSSH is identified without sending POSIX probes", async () => {
  const detected: string[] = [];
  await runDistroDetection({
    host: { id: 'windows', os: 'linux' },
    terminalBackend: {
      getSessionRemoteInfo: async () => ({ success: true, remoteSshVersion: 'SSH-2.0-OpenSSH_for_Windows_9.5' }),
      getSessionDistroInfo: async () => { throw new Error('must not probe Windows with POSIX commands'); },
    },
    onOsDetected: (_id: string, distro: string) => detected.push(distro),
  } as never, 'windows', registerConnectionToken('windows'));
  assert.deepEqual(detected, ['windows']);
});

test("failed or unrecognized probes do not invent an operating system", async () => {
  const detected: string[] = [];
  await runDistroDetection({
    host: { id: 'unknown', os: 'linux' },
    terminalBackend: {
      getSessionDistroInfo: async () => ({ success: true, stdout: '', stderr: 'Linux command not found' }),
    },
    onOsDetected: (_id: string, distro: string) => detected.push(distro),
  } as never, 'unknown', registerConnectionToken('unknown'));
  assert.deepEqual(detected, []);
});

test("a superseded Windows detection cannot update the newer connection", async () => {
  const detected: string[] = [];
  await runDistroDetection({
    host: { id: 'windows', os: 'linux' },
    terminalBackend: {
      getSessionRemoteInfo: async () => {
        registerConnectionToken('reconnected');
        return { success: true, remoteSshVersion: 'OpenSSH_for_Windows_9.5' };
      },
    },
    onOsDetected: (_id: string, distro: string) => detected.push(distro),
  } as never, 'reconnected', registerConnectionToken('reconnected'));
  assert.deepEqual(detected, []);
});
