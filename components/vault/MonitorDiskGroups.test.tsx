import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useMonitorDiskGroups } from "../../application/state/useMonitorDiskGroups";
import { I18nProvider } from "../../application/i18n/I18nProvider";
import { MonitorDiskUsage } from "./MonitorDiskUsage";
import { MonitorDiskIo } from "./MonitorDiskIo";

function Harness({ percent, hideCapacity = false }: { percent: number; hideCapacity?: boolean }) {
  const groups = useMonitorDiskGroups();
  const stats = { diskPercent: 20, disks: [
    { mountPoint: "/boot/efi", percent, used: 1, total: 2 },
    { mountPoint: "/", percent: 20, used: 20, total: 100 },
    { mountPoint: "/bd10", percent: 10, used: 1, total: 10 },
    { mountPoint: "/boot", percent: 30, used: 1, total: 3 },
    { mountPoint: "/bd02", percent: 10, used: 1, total: 10 },
  ] };
  return <I18nProvider locale="en">{["a", "b"].map(id => {
    const layout = groups.layoutFor(id, stats);
    return <div key={id} data-host={id}>
      {!hideCapacity && <MonitorDiskUsage stats={stats} listLayout={layout} onToggleSystem={() => groups.toggle(id)} />}
      <MonitorDiskIo stats={stats} listLayout={layout} showSystemToggle={hideCapacity} onToggleSystem={() => groups.toggle(id)} />
    </div>;
  })}</I18nProvider>;
}

test("system disclosure is per host, aligns both columns, and reacts to the strict 80% threshold", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const host = (id: string) => dom.window.document.querySelector(`[data-host=${id}]`)!;
  const button = (id: string) => host(id).querySelector<HTMLButtonElement>("[data-monitor-system-disks]")!;
  const assertAligned = (id: string, expected: string[]) => {
    const capacity = [...host(id).querySelectorAll("[data-monitor-disk]")].map(row => row.getAttribute("data-monitor-disk"));
    const io = [...host(id).querySelectorAll("[data-monitor-disk-io]")].map(row => row.getAttribute("data-monitor-disk-io"));
    assert.deepEqual(capacity, expected);
    assert.deepEqual(io, expected);
    assert.equal(host(id).querySelectorAll("[data-monitor-system-io-slot]").length, 1);
  };
  try {
    await act(async () => root.render(<Harness percent={80} />));
    assertAligned("a", ["/", "/bd02", "/bd10"]);
    assert.equal(button("a").getAttribute("aria-expanded"), "false");
    await act(async () => button("a").click());
    assertAligned("a", ["/", "/bd02", "/bd10", "/boot", "/boot/efi"]);
    assertAligned("b", ["/", "/bd02", "/bd10"]);
    await act(async () => button("a").click());
    await act(async () => root.render(<Harness percent={81} />));
    for (const id of ["a", "b"]) {
      assertAligned(id, ["/", "/bd02", "/bd10", "/boot", "/boot/efi"]);
      assert.equal(button(id).getAttribute("aria-expanded"), "true");
      assert.equal(button(id).disabled, true);
      const alert = host(id).querySelector("[data-monitor-disk-alert]")!;
      assert.equal(alert.getAttribute("data-monitor-disk"), "/boot/efi");
      assert.match(alert.innerHTML, /bg-destructive\/80/);
      assert.match(alert.innerHTML, /text-destructive/);
    }
    await act(async () => root.render(<Harness percent={79} />));
    assertAligned("a", ["/", "/bd02", "/bd10"]);
    assert.equal(host("a").querySelector("[data-monitor-disk-alert]"), null);
    await act(async () => root.render(<Harness percent={79} hideCapacity />));
    assert.equal(host("a").querySelector("[data-monitor-disk]"), null);
    assert.equal(button("a").getAttribute("aria-expanded"), "false");
    await act(async () => button("a").click());
    assert.deepEqual([...host("a").querySelectorAll("[data-monitor-disk-io]")].map(row => row.getAttribute("data-monitor-disk-io")), ["/", "/bd02", "/bd10", "/boot", "/boot/efi"]);
    assert.equal(button("b").getAttribute("aria-expanded"), "false");
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(globals)) {
      const descriptor = originals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
