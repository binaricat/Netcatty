import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { I18nProvider } from "../application/i18n/I18nProvider";
import type { Host } from "../types";
import HostDetailsPanel from "./HostDetailsPanel";
import { installDomEnvironment } from "./test-support/renderReactDom";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select } from "./ui/select";
import { TooltipProvider } from "./ui/tooltip";

for (const kind of ["standalone", "companion", "new"] as const) {
  test(`${kind} RDP keeps invalid resolution drafts visible and blocks saving`, async () => {
    const dom = installDomEnvironment();
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCancelRaf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(0), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
    let renderer: ReactTestRenderer | undefined;
    const saved: Host[] = [];
    const host: Host = {
      id: "rdp-host", label: "Desktop", hostname: "desktop.example.com",
      username: "root", password: "password", authMethod: "password",
      protocol: kind === "companion" ? "ssh" : "rdp", tags: [], os: "windows",
      rdpConfig: {
        enabled: true, defaultConnect: true, resolutionMode: "fixed", width: 1920, height: 1080,
      },
    };
    try {
      await act(async () => {
        renderer = create(
          <I18nProvider locale="en"><TooltipProvider>
            <HostDetailsPanel
              initialData={kind === "new" ? undefined : host}
              initialProtocol="rdp"
              availableKeys={[]} identities={[]} groups={[]}
              terminalThemeId="default" terminalFontSize={14} layout="inline"
              onSave={(value) => saved.push(value)} onCancel={() => {}}
            />
          </TooltipProvider></I18nProvider>,
        );
      });
      if (kind === "new") {
        await act(async () => {
          const hostname = renderer!.root.findAllByType(Input).find((input) =>
            input.props.placeholder === "IP or Hostname");
          assert.ok(hostname);
          hostname.props.onChange({ target: { value: host.hostname } });
          const mode = renderer!.root.findAllByType(Select).find((select) => select.props.value === "dynamic");
          assert.ok(mode);
          mode.props.onValueChange("fixed");
        });
      }
      const input = (dimension: string) => renderer!.root.findAllByType(Input).find((field) =>
        field.props.id?.endsWith(`-${dimension}`))!;
      const change = async (dimension: string, value: string) => {
        await act(async () => { input(dimension).props.onChange({ target: { value } }); });
      };
      const save = async () => {
        await act(async () => {
          const button = renderer!.root.findAllByType(Button).find((item) => item.props["aria-label"] === "Save");
          assert.ok(button);
          await button.props.onClick();
        });
      };
      assert.equal(input("width").props.value, "1920");
      for (const value of ["192", "19", "", "199", "8193", "3840.5", "abc"]) {
        await change("width", value);
        assert.equal(input("width").props.value, value);
        assert.equal(input("width").props["aria-invalid"], true);
        assert.match(JSON.stringify(renderer!.toJSON()), /Enter a whole number from 200 to 8192/);
        await save();
        assert.equal(saved.length, 0);
        assert.equal(input("width").props.value, value, "save must preserve the invalid draft");
      }
      await change("width", "3840");
      assert.equal(input("width").props.value, "3840");
      assert.equal(input("width").props["aria-invalid"], false);
      await change("height", "192");
      await save();
      assert.equal(saved.length, 0);
      assert.equal(input("height").props.value, "192");
      await change("height", "2160");
      await save();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].rdpConfig?.width, 3840);
      assert.equal(saved[0].rdpConfig?.height, 2160);
    } finally {
      if (renderer) await act(async () => { renderer!.unmount(); });
      globalThis.requestAnimationFrame = previousRaf;
      globalThis.cancelAnimationFrame = previousCancelRaf;
      dom.cleanup();
    }
  });
}
