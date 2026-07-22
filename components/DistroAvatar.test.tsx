import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DistroAvatar } from "./DistroAvatar.tsx";
import { LINUX_DISTRO_OPTION_IDS } from "./HostDetailsPanel.helpers.ts";
import type { Host } from "../types.ts";

const baseHost: Pick<Host, "distro" | "manualDistro" | "distroMode" | "os" | "protocol" | "iconMode" | "iconId" | "iconColor"> = {
  os: "linux",
  protocol: "ssh",
};

test("DistroAvatar renders custom host icon before distro color", () => {
  const markup = renderToStaticMarkup(
    <DistroAvatar
      host={{ ...baseHost, distro: "ubuntu", iconMode: "custom", iconId: "database", iconColor: "blue" }}
      fallback="DB"
    />,
  );

  assert.match(markup, /background-color:#2563EB/i);
  assert.doesNotMatch(markup, /bg-\[#E95420\]/);
});

test("DistroAvatar keeps serial hosts on the USB icon", () => {
  const markup = renderToStaticMarkup(
    <DistroAvatar
      host={{ ...baseHost, protocol: "serial", iconMode: "custom", iconId: "database", iconColor: "blue" }}
      fallback="S"
    />,
  );

  assert.match(markup, /bg-amber-600/);
  assert.doesNotMatch(markup, /background-color:#2563EB/i);
});

test("DistroAvatar xs size uses compact corners without appearing circular", () => {
  const markup = renderToStaticMarkup(
    <DistroAvatar
      host={{ ...baseHost, distro: "ubuntu" }}
      fallback="U"
      size="xs"
    />,
  );

  assert.match(markup, /h-4 w-4 rounded-\[4px\]/);
  assert.doesNotMatch(markup, /rounded-full/);
});

test("DistroAvatar tree size uses compact host icon corners", () => {
  const markup = renderToStaticMarkup(
    <DistroAvatar
      host={{ ...baseHost, distro: "ubuntu" }}
      fallback="U"
      size="tree"
    />,
  );

  assert.match(markup, /h-6 w-6 rounded-\[6px\]/);
});

test("DistroAvatar keeps distro icon and applies custom palette color when icon mode is automatic", () => {
  const markup = renderToStaticMarkup(
    <DistroAvatar
      host={{ ...baseHost, distro: "ubuntu", iconMode: "auto", iconId: "database", iconColor: "blue" }}
      fallback="U"
    />,
  );

  assert.match(markup, /background-color:#2563EB/i);
  assert.match(markup, /src="\/distro\/ubuntu.svg"/);
  assert.doesNotMatch(markup, /bg-\[#E95420\]/);
});

test("DistroAvatar renders H3C logo without monochrome inversion", () => {
  const markup = renderToStaticMarkup(
    <DistroAvatar
      host={{ ...baseHost, distro: "h3c" }}
      fallback="H"
    />,
  );

  assert.match(markup, /src="\/distro\/h3c.svg"/);
  assert.match(markup, /bg-white/);
  assert.doesNotMatch(markup, /invert brightness-0/);
});

test("DistroAvatar renders the FreeBSD logo for a detected FreeBSD host", () => {
  const markup = renderToStaticMarkup(
    <DistroAvatar
      host={{ distro: "freebsd", os: "linux" }}
      fallback="FB"
    />,
  );

  assert.match(markup, /src="\/distro\/freebsd\.svg"/);
  assert.match(markup, /alt="freebsd"/);
});

test("FreeBSD is available as a manual host icon choice", () => {
  assert.ok(LINUX_DISTRO_OPTION_IDS.includes("freebsd"));
});
