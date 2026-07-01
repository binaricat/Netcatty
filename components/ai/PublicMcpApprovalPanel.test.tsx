import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import { PublicMcpApprovalPanelView } from "./PublicMcpApprovalPanel";

const renderPanel = (
  props: Partial<React.ComponentProps<typeof PublicMcpApprovalPanelView>> = {},
) => renderToStaticMarkup(
  React.createElement(
    I18nProvider,
    { locale: "en" },
    React.createElement(PublicMcpApprovalPanelView, {
      approvals: [
        {
          toolCallId: "mcp_approval_1",
          toolName: "public/terminalExecute",
          args: { sessionId: "ssh-1", command: "uptime" },
        },
      ],
      onApprove: () => {},
      onReject: () => {},
      ...props,
    }),
  ),
);

test("PublicMcpApprovalPanelView renders Public MCP approvals without blocking the page", () => {
  const markup = renderPanel();

  assert.match(markup, /Public MCP request/);
  assert.match(markup, /public\/terminalExecute/);
  assert.match(markup, /uptime/);
  assert.match(markup, /Approve/);
  assert.match(markup, /Reject/);
  assert.match(markup, /pointer-events-none/);
  assert.match(markup, /pointer-events-auto/);
});

test("PublicMcpApprovalPanelView renders nothing when there are no approvals", () => {
  assert.equal(renderPanel({ approvals: [] }), "");
});

test("PublicMcpApprovalPanelView masks secret host arguments", () => {
  const markup = renderPanel({
    approvals: [
      {
        toolCallId: "mcp_approval_secret",
        toolName: "vault_hosts_create",
        args: {
          hosts: JSON.stringify([
            {
              hostname: "secret.example.com",
              password: "pw-secret",
              telnetPassword: "tn-secret",
            },
          ]),
        },
      },
    ],
  });

  assert.doesNotMatch(markup, /pw-secret|tn-secret/);
  assert.match(markup, /REDACTED/);
});
