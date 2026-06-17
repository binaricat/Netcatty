import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { HostIconPicker } from "./HostIconPicker.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const renderPicker = (props: Partial<React.ComponentProps<typeof HostIconPicker>> = {}) =>
  renderToStaticMarkup(
    <I18nProvider locale="en">
      <TooltipProvider>
        <HostIconPicker
          iconMode={props.iconMode}
          iconId={props.iconId}
          iconColor={props.iconColor}
          onChange={() => {}}
          onReset={() => {}}
        />
      </TooltipProvider>
    </I18nProvider>,
  );

test("HostIconPicker renders automatic mode without selected custom defaults", () => {
  const markup = renderPicker();

  assert.match(markup, /Automatic/);
  assert.doesNotMatch(markup, /aria-pressed="true"[^>]*Database/);
});

test("HostIconPicker renders custom choices and reset when custom", () => {
  const markup = renderPicker({ iconMode: "custom", iconId: "database", iconColor: "blue" });

  assert.match(markup, /Database/);
  assert.match(markup, /Globe/);
  assert.match(markup, /Show icon library/);
  assert.doesNotMatch(markup, /Server settings/);
  assert.match(markup, /grid-cols-5/);
  assert.match(markup, /Blue/);
  assert.match(markup, /Reset/);
  assert.match(markup, /Built-in icon replaces Linux Distribution for this host/);
});

test("HostIconPicker shows two rows of color swatches in automatic mode", () => {
  const markup = renderPicker({ iconMode: "auto", iconColor: "violet" });

  assert.match(markup, /Violet/);
  assert.match(markup, /grid-cols-8/);
  assert.match(markup, /Use Linux Distribution icon and selected color/);
});

test("HostIconPicker does not expose image upload", () => {
  const markup = renderPicker({ iconMode: "custom", iconId: "database", iconColor: "blue" });

  assert.doesNotMatch(markup, /upload/i);
  assert.doesNotMatch(markup, /choose file/i);
});

test("HostIconPicker normalizes invalid incoming custom values only for editing", () => {
  const markup = renderPicker({
    iconMode: "custom",
    iconId: "bad" as React.ComponentProps<typeof HostIconPicker>["iconId"],
    iconColor: "bad" as React.ComponentProps<typeof HostIconPicker>["iconColor"],
  });

  assert.match(markup, /Server/);
  assert.match(markup, /Blue/);
  assert.match(markup, /Built-in icon replaces Linux Distribution/);
});
