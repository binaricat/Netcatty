import assert from "node:assert/strict";
import test from "node:test";

import type { VaultImportResult } from "../../domain/vaultImport.ts";
import {
  importVaultHostsInWorker,
  type VaultImportWorkerLike,
} from "./vaultImportWorkerClient.ts";

const parsedResult: VaultImportResult = {
  hosts: [{
    id: "host-1",
    label: "Production",
    hostname: "10.0.0.1",
    port: 22,
    username: "root",
    protocol: "ssh",
    tags: [],
    os: "linux",
  }],
  groups: [],
  issues: [],
  stats: { parsed: 1, imported: 1, skipped: 0, duplicates: 0 },
};

class FakeVaultImportWorker implements VaultImportWorkerLike {
  listeners = new Map<string, Set<(event: MessageEvent | ErrorEvent) => void>>();
  postedMessage: unknown;
  terminated = false;

  addEventListener(type: "message" | "error", listener: (event: MessageEvent | ErrorEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "message" | "error", listener: (event: MessageEvent | ErrorEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown) {
    this.postedMessage = message;
  }

  terminate() {
    this.terminated = true;
  }

  emit(type: "message" | "error", data: unknown) {
    const event = type === "message"
      ? ({ data } as MessageEvent)
      : ({ message: String(data) } as ErrorEvent);
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("vault import stays pending while a worker parses and forwards real stage progress", async () => {
  const worker = new FakeVaultImportWorker();
  const progress: Array<{ stage: string; percent: number }> = [];
  let settled = false;
  const file = new File(["Label,Hostname\nProduction,10.0.0.1"], "hosts.csv");
  Object.defineProperty(file, "webkitRelativePath", {
    value: "Sessions/Production/hosts.csv",
  });

  const promise = importVaultHostsInWorker({
    format: "csv",
    files: [file],
    createWorker: () => worker,
    onProgress: (update) => progress.push(update),
  }).finally(() => {
    settled = true;
  });

  assert.deepEqual(worker.postedMessage, {
    type: "import",
    format: "csv",
    files: [file],
    relativePaths: ["Sessions/Production/hosts.csv"],
    encoding: undefined,
  });
  assert.equal(settled, false);

  worker.emit("message", {
    type: "progress",
    progress: { stage: "reading", percent: 10 },
  });
  worker.emit("message", {
    type: "progress",
    progress: { stage: "parsing", percent: 55 },
  });
  worker.emit("message", { type: "result", result: parsedResult });

  assert.deepEqual(await promise, parsedResult);
  assert.deepEqual(progress, [
    { stage: "reading", percent: 10 },
    { stage: "parsing", percent: 55 },
  ]);
  assert.equal(worker.terminated, true);
});

test("vault import surfaces worker failures and always stops the worker", async () => {
  const worker = new FakeVaultImportWorker();
  const promise = importVaultHostsInWorker({
    format: "csv",
    files: [new File(["bad input"], "hosts.csv")],
    createWorker: () => worker,
  });

  worker.emit("message", { type: "error", message: "Unable to parse CSV" });

  await assert.rejects(promise, /Unable to parse CSV/);
  assert.equal(worker.terminated, true);
});

test("vault import cancellation stops the worker and rejects before applying a result", async () => {
  const worker = new FakeVaultImportWorker();
  const controller = new AbortController();
  const promise = importVaultHostsInWorker({
    format: "csv",
    files: [new File(["Label,Hostname\nA,a.example.com"], "hosts.csv")],
    signal: controller.signal,
    createWorker: () => worker,
  });

  controller.abort();

  await assert.rejects(promise, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  assert.equal(worker.terminated, true);
});
