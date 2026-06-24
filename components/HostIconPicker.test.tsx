import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { HostIconPicker } from "./HostIconPicker.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const distroOptions = [
  {
    value: "linux",
    label: "Generic Linux",
    icon: "/distro/linux.svg",
    bgClass: "bg-[#333333]",
  },
  {
    value: "ubuntu",
    label: "Ubuntu",
    icon: "/distro/ubuntu.svg",
    bgClass: "bg-[#E95420]",
  },
];

const hostIconPickerSource = readFileSync(new URL("./HostIconPicker.tsx", import.meta.url), "utf8");

const renderPicker = (props: Partial<React.ComponentProps<typeof HostIconPicker>> = {}) =>
  renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>
        <HostIconPicker
          distroMode={props.distroMode}
          manualDistro={props.manualDistro}
          effectiveDistro={props.effectiveDistro}
          distroOptions={props.distroOptions || distroOptions}
          getDistroOptionLabel={props.getDistroOptionLabel || ((value) => distroOptions.find((option) => option.value === value)?.label || "Unknown")}
          iconMode={props.iconMode}
          iconId={props.iconId}
          iconColorMode={props.iconColorMode}
          iconColor={props.iconColor}
          iconColorCustom={props.iconColorCustom}
          manualIconMenuOpen={props.manualIconMenuOpen}
          onChange={() => {}}
        />
      </TooltipProvider>
    </I18nProvider>,
  );

test("HostIconPicker renders automatic source and automatic color by default", () => {
  const markup = renderPicker({ effectiveDistro: "ubuntu" });

  assert.match(markup, /Source/);
  assert.match(markup, /Auto-detect/);
  assert.match(markup, /Current/);
  assert.match(markup, /Ubuntu/);
  assert.match(markup, /Icon color/);
  assert.match(markup, /Automatic/);
  assert.match(markup, /Current color/);
  assert.doesNotMatch(markup, /Brand/);
  assert.doesNotMatch(markup, /Custom color/);
});

test("HostIconPicker renders a single manual icon dropdown in manual source mode", () => {
  const markup = renderPicker({ distroMode: "manual", manualDistro: "linux", manualIconMenuOpen: true });

  assert.match(markup, /Manual icon/);
  assert.match(markup, /Generic Linux/);
  assert.match(markup, /aria-label="Manual icon"/);
});

test("HostIconPicker renders built-in type icons when a custom type is selected", () => {
  const markup = renderPicker({ distroMode: "manual", iconMode: "custom", iconId: "database", manualIconMenuOpen: true });

  assert.match(markup, /Database/);
  assert.match(markup, /Current color/);
  assert.match(markup, /background-color:#0891B2/);
});

test("HostIconPicker shows the automatic brand color preview", () => {
  const markup = renderPicker({ distroMode: "manual", manualDistro: "ubuntu" });

  assert.match(markup, /Current color/);
  assert.match(markup, /bg-\[#E95420\]/);
  assert.match(markup, /Ubuntu/);
});

test("HostIconPicker ignores stale colors when color mode is automatic", () => {
  const markup = renderPicker({
    distroMode: "manual",
    iconMode: "custom",
    iconId: "database",
    iconColorMode: "auto",
    iconColor: "violet",
    iconColorCustom: "#12ABEF",
  });

  assert.match(markup, /Automatic/);
  assert.match(markup, /Current color/);
  assert.match(markup, /Database/);
  assert.match(markup, /background-color:#0891B2/);
  assert.doesNotMatch(markup, /#12ABEF/);
  assert.doesNotMatch(markup, /Violet/);
});

test("HostIconPicker keeps brand/type tabs inside the manual icon dropdown menu", () => {
  assert.match(hostIconPickerSource, /<SelectContent className="min-w-\[16rem\]" hideScrollButtons>[\s\S]*role="tab"[\s\S]*hostDetails\.icon\.tab\.brand/);
  assert.match(hostIconPickerSource, /<SelectContent className="min-w-\[16rem\]" hideScrollButtons>[\s\S]*hostDetails\.icon\.tab\.type/);
  assert.doesNotMatch(hostIconPickerSource, /<TabsList/);
});

test("HostIconPicker renders preset and custom color choices in manual color mode", () => {
  const markup = renderPicker({ iconColorMode: "manual", iconColor: "violet" });

  assert.match(markup, /Manual/);
  assert.match(markup, /Violet/);
});

test("HostIconPicker renders a custom hex color input", () => {
  const markup = renderPicker({ iconColorMode: "manual", iconColorCustom: "#12ABEF" });

  assert.match(markup, /Custom color/);
  assert.match(markup, /#12ABEF/);
  assert.match(markup, /type="color"/);
});

test("HostIconPicker does not expose image upload", () => {
  const markup = renderPicker({ distroMode: "manual", iconMode: "custom", iconId: "database" });

  assert.doesNotMatch(markup, /upload/i);
  assert.doesNotMatch(markup, /choose file/i);
});
