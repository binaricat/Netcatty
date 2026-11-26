import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { Host } from "../../domain/models.ts";
import { SerialHostDetailsPanel } from "../SerialHostDetailsPanel.tsx";
import { installDomEnvironment } from "../test-support/renderReactDom.tsx";
import { Combobox } from "../ui/combobox.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { SerialPortField } from "./SerialPortField.tsx";
import {
  useSerialPortDiscovery,
  type UseSerialPortDiscoveryResult,
} from "./useSerialPortDiscovery.ts";

const samplePorts = [
  {
    path: "/dev/ttyUSB0",
    manufacturer: "FTDI",
    serialNumber: "",
    vendorId: "",
    productId: "",
    pnpId: "",
  },
  {
    path: "/dev/ttyUSB1",
    manufacturer: "",
    serialNumber: "",
    vendorId: "",
    productId: "",
    pnpId: "",
  },
];

test("useSerialPortDiscovery gates loading on enabled and invokes onPortsLoaded", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = environment.IS_REACT_ACT_ENVIRONMENT;
  const dom = installDomEnvironment();
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  let listCalls = 0;
  const loadedPayloads: Array<Array<{ path: string; manufacturer?: string }>> = [];
  (window as unknown as { netcatty?: Partial<NetcattyBridge> }).netcatty = {
    listSerialPorts: async () => {
      listCalls += 1;
      return samplePorts;
    },
  };

  let latest: UseSerialPortDiscoveryResult | undefined;
  const Harness: React.FC<{ enabled: boolean }> = ({ enabled }) => {
    latest = useSerialPortDiscovery({
      enabled,
      onPortsLoaded: (ports) => {
        loadedPayloads.push(ports);
      },
    });
    return null;
  };

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(<Harness enabled={false} />);
    });
    assert.equal(listCalls, 0);
    assert.deepEqual(latest!.portOptions, []);
    assert.equal(loadedPayloads.length, 0);

    await act(async () => {
      renderer!.update(<Harness enabled={true} />);
    });
    assert.equal(listCalls, 1);
    assert.equal(loadedPayloads.length, 1);
    assert.deepEqual(latest!.portOptions, [
      { value: "/dev/ttyUSB0", label: "/dev/ttyUSB0", sublabel: "FTDI" },
      { value: "/dev/ttyUSB1", label: "/dev/ttyUSB1", sublabel: undefined },
    ]);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    dom.cleanup();
    environment.IS_REACT_ACT_ENVIRONMENT = prevAct;
  }
});

test("SerialHostDetailsPanel preserves its saved port when port discovery resolves", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = environment.IS_REACT_ACT_ENVIRONMENT;
  const dom = installDomEnvironment();
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  let listCalls = 0;
  (window as unknown as { netcatty?: Partial<NetcattyBridge> }).netcatty = {
    listSerialPorts: async () => {
      listCalls += 1;
      return samplePorts;
    },
  };

  const host: Host = {
    id: "serial-existing",
    label: "Switch Console",
    hostname: "COM7",
    protocol: "serial",
    port: 115200,
    username: "",
    tags: [],
    os: "linux",
    serialConfig: {
      path: "COM7",
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    },
  };

  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(
        <I18nProvider locale="en">
          <TooltipProvider>
            <SerialHostDetailsPanel
              initialData={host}
              onSave={() => {}}
              onCancel={() => {}}
            />
          </TooltipProvider>
        </I18nProvider>,
      );
    });

    assert.equal(listCalls, 1);
    const portField = renderer!.root.findByType(SerialPortField);
    assert.equal(portField.props.value, "COM7");
    assert.equal(portField.props.portOptions.length, 2);
    const combobox = portField.findByType(Combobox);
    assert.equal(combobox.props.value, "COM7");
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
    dom.cleanup();
    environment.IS_REACT_ACT_ENVIRONMENT = prevAct;
  }
});

test("SerialPortField toggles refresh icon and invalid port validation message", () => {
  const withoutIcon = renderToStaticMarkup(
    <I18nProvider locale="en">
      <SerialPortField
        value="COM3"
        onChange={() => {}}
        portOptions={[]}
        isLoadingPorts={false}
        onRefresh={() => {}}
        isPortValid={true}
        showRefreshIcon={false}
      />
    </I18nProvider>,
  );
  assert.doesNotMatch(withoutIcon, /lucide-refresh-cw/);
  assert.doesNotMatch(withoutIcon, /text-destructive/);

  const withIconAndError = renderToStaticMarkup(
    <I18nProvider locale="en">
      <SerialPortField
        value="bad-port"
        onChange={() => {}}
        portOptions={[]}
        isLoadingPorts={false}
        onRefresh={() => {}}
        isPortValid={false}
        showRefreshIcon={true}
      />
    </I18nProvider>,
  );
  assert.match(withIconAndError, /lucide-refresh-cw/);
  assert.match(withIconAndError, /text-destructive/);
});
