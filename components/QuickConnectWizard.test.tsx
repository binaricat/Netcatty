import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../application/i18n/I18nProvider";
import QuickConnectWizard from "./QuickConnectWizard";

test("QuickConnectWizard offers ET without obsolete Mosh path or log controls", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "example.com" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Eternal Terminal/);
  assert.doesNotMatch(markup, /mosh --server/);
  assert.doesNotMatch(markup, /Show logs|Hide logs/);
});

test("quick connect shows saved identities as credential presets", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "192.0.2.10" }}
        keys={[]}
        identities={[{
          id: "identity-root",
          label: "Root devices",
          username: "root",
          authMethod: "password",
          password: "secret",
          created: 1,
        }]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Credential preset/);
  assert.match(markup, /Choose a saved identity/);
});

test("quick connect protocol step uses simplified connect header and protocol icons", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "10.2.0.31" }}
        keys={[]}
        identities={[]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Connect to 10\.2\.0\.31:22/);
  assert.match(markup, /lucide-plug/);
  assert.doesNotMatch(markup, />_</);
  assert.match(markup, /bg-sky-500\/20 text-sky-500/);
  assert.match(markup, /bg-violet-500\/10 text-violet-500/);
  assert.match(markup, /bg-emerald-500\/10 text-emerald-500/);
  assert.match(markup, /bg-amber-500\/10 text-amber-500/);
  assert.match(markup, /lucide-shield/);
  assert.match(markup, /lucide-radio/);
  assert.match(markup, /lucide-link-2/);
  assert.match(markup, /lucide-terminal/);
  assert.match(markup, /text-sm font-medium leading-none[^>]*>Choose protocol</);
});

test("quick connect credential section title matches protocol section title style", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "10.2.0.31" }}
        keys={[]}
        identities={[{
          id: "identity-root",
          label: "Root devices",
          username: "root",
          authMethod: "password",
          password: "secret",
          created: 1,
        }]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /text-sm font-medium leading-none[^>]*>Choose protocol</);
  assert.match(markup, /text-sm font-medium leading-none[^>]*>Credential preset</);
});

