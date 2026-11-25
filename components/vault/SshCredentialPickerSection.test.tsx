import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { SSHKey } from "../../types.ts";
import { SshAlgorithmOverridesCollapsible } from "../host-details/SshAlgorithmOverridesCollapsible.tsx";
import { installDomEnvironment } from "../test-support/renderReactDom.tsx";
import { Combobox } from "../ui/combobox.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import {
  SshCredentialPickerSection,
  type SshCredentialPickerSectionProps,
} from "./SshCredentialPickerSection.tsx";

const sampleKeys: { key: SSHKey[]; certificate: SSHKey[] } = {
  key: [
    {
      id: "key-1",
      label: "Prod Ed25519",
      type: "ED25519",
      publicKey: "ssh-ed25519 AAAA",
      privateKey: "PRIVATE",
      category: "key",
      source: "generated",
      created: 1700000000000,
    },
    {
      id: "key-2",
      label: "Legacy RSA",
      type: "RSA",
      keySize: 4096,
      publicKey: "ssh-rsa AAAA",
      privateKey: "PRIVATE",
      category: "key",
      source: "generated",
      created: 1700000000001,
    },
  ],
  certificate: [
    {
      id: "cert-1",
      label: "Prod Cert",
      type: "ED25519",
      publicKey: "ssh-ed25519-cert-v01@openssh.com AAAA",
      privateKey: "PRIVATE",
      category: "certificate",
      source: "imported",
      created: 1700000000002,
    },
  ],
};

const identityT = (key: string) => key;

function buildProps(
  overrides: Partial<SshCredentialPickerSectionProps> = {},
): SshCredentialPickerSectionProps {
  return {
    visible: true,
    identityFileId: undefined,
    keysByCategory: sampleKeys,
    selectedCredentialType: null,
    setSelectedCredentialType: () => {},
    credentialPopoverOpen: false,
    setCredentialPopoverOpen: () => {},
    newKeyFilePath: "",
    setNewKeyFilePath: () => {},
    onSelectKey: () => {},
    onSelectCertificate: () => {},
    onAddLocalKeyFile: () => {},
    t: identityT,
    ...overrides,
  };
}

test("SshCredentialPickerSection renders nothing when visible is false", () => {
  const markup = renderToStaticMarkup(
    <TooltipProvider>
      <SshCredentialPickerSection {...buildProps({ visible: false })} />
    </TooltipProvider>,
  );
  assert.equal(markup, "");
});

test("SshCredentialPickerSection routes key and certificate selection through caller callbacks", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = environment.IS_REACT_ACT_ENVIRONMENT;
  const dom = installDomEnvironment();
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  const selectedKeys: string[] = [];
  const selectedCerts: string[] = [];
  let renderer: ReactTestRenderer | undefined;

  try {
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <SshCredentialPickerSection
            {...buildProps({
              selectedCredentialType: "key",
              onSelectKey: (id) => selectedKeys.push(id),
            })}
          />
        </TooltipProvider>,
      );
    });

    const keyCombobox = renderer!.root.findByType(Combobox);
    assert.deepEqual(
      keyCombobox.props.options.map((opt: { value: string; label: string; sublabel?: string }) => ({
        value: opt.value,
        label: opt.label,
        sublabel: opt.sublabel,
      })),
      [
        { value: "key-1", label: "Prod Ed25519", sublabel: "ED25519" },
        { value: "key-2", label: "Legacy RSA", sublabel: "RSA 4096" },
      ],
    );
    await act(async () => {
      keyCombobox.props.onValueChange("key-2");
    });
    assert.deepEqual(selectedKeys, ["key-2"]);

    await act(async () => {
      renderer!.update(
        <TooltipProvider>
          <SshCredentialPickerSection
            {...buildProps({
              selectedCredentialType: "certificate",
              onSelectCertificate: (id) => selectedCerts.push(id),
            })}
          />
        </TooltipProvider>,
      );
    });

    const certCombobox = renderer!.root.findByType(Combobox);
    assert.equal(certCombobox.props.options.length, 1);
    assert.equal(certCombobox.props.options[0].value, "cert-1");
    await act(async () => {
      certCombobox.props.onValueChange("cert-1");
    });
    assert.deepEqual(selectedCerts, ["cert-1"]);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
    dom.cleanup();
    environment.IS_REACT_ACT_ENVIRONMENT = prevAct;
  }
});

test("SshCredentialPickerSection preserves localKeyFile Enter submit and host vs group cancel semantics", async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prevAct = environment.IS_REACT_ACT_ENVIRONMENT;
  const dom = installDomEnvironment();
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  environment.IS_REACT_ACT_ENVIRONMENT = true;

  const added: Array<{ path: string; source: "input" | "browse" }> = [];
  const typeUpdates: Array<string | null> = [];
  const pathUpdates: string[] = [];
  let hostCancelCount = 0;
  let renderer: ReactTestRenderer | undefined;

  try {
    // Group variant: no onCancelLocalKeyFile -> X button only clears selectedCredentialType
    await act(async () => {
      renderer = create(
        <TooltipProvider>
          <SshCredentialPickerSection
            {...buildProps({
              selectedCredentialType: "localKeyFile",
              newKeyFilePath: "  ~/.ssh/id_prod  ",
              setSelectedCredentialType: (next) => typeUpdates.push(next),
              setNewKeyFilePath: (next) => pathUpdates.push(next),
              onAddLocalKeyFile: (filePath, source) => added.push({ path: filePath, source }),
            })}
          />
        </TooltipProvider>,
      );
    });

    const input = renderer!.root.findByType("input");
    let prevented = false;
    await act(async () => {
      input.props.onKeyDown({
        key: "Enter",
        preventDefault: () => { prevented = true; },
      });
    });
    assert.equal(prevented, true);
    assert.deepEqual(added, [{ path: "~/.ssh/id_prod", source: "input" }]);

    const buttons = renderer!.root.findAllByType("button");
    const cancelButton = buttons[buttons.length - 1];
    await act(async () => {
      cancelButton.props.onClick();
    });
    assert.deepEqual(typeUpdates, [null]);
    assert.deepEqual(pathUpdates, []);

    // Host variant: custom onCancelLocalKeyFile clears both type and newKeyFilePath
    await act(async () => {
      renderer!.update(
        <TooltipProvider>
          <SshCredentialPickerSection
            {...buildProps({
              selectedCredentialType: "localKeyFile",
              newKeyFilePath: "~/.ssh/id_host",
              setSelectedCredentialType: (next) => typeUpdates.push(next),
              setNewKeyFilePath: (next) => pathUpdates.push(next),
              onCancelLocalKeyFile: () => {
                hostCancelCount += 1;
                typeUpdates.push(null);
                pathUpdates.push("");
              },
            })}
          />
        </TooltipProvider>,
      );
    });

    const hostButtons = renderer!.root.findAllByType("button");
    await act(async () => {
      hostButtons[hostButtons.length - 1].props.onClick();
    });
    assert.equal(hostCancelCount, 1);
    assert.deepEqual(typeUpdates, [null, null]);
    assert.deepEqual(pathUpdates, [""]);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
    dom.cleanup();
    environment.IS_REACT_ACT_ENVIRONMENT = prevAct;
  }
});

test("SshAlgorithmOverridesCollapsible shows customized badge only when overrides are present", () => {
  const emptyMarkup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <SshAlgorithmOverridesCollapsible
        open={false}
        onOpenChange={() => {}}
        value={undefined}
        legacyEnabled={false}
        onChange={() => {}}
        t={identityT}
      />
    </I18nProvider>,
  );
  assert.match(emptyMarkup, /hostDetails\.algorithms\.advanced/);
  assert.doesNotMatch(emptyMarkup, /hostDetails\.algorithms\.customized/);

  const customizedMarkup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <SshAlgorithmOverridesCollapsible
        open={false}
        onOpenChange={() => {}}
        value={{ kex: ["curve25519-sha256"] }}
        legacyEnabled={false}
        onChange={() => {}}
        t={identityT}
      />
    </I18nProvider>,
  );
  assert.match(customizedMarkup, /hostDetails\.algorithms\.customized/);
});
