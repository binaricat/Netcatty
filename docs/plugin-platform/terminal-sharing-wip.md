# Selected terminal sharing — implementation WIP

This historical checklist describes commit `3cdc97782`. The continuation on
`feat/plugin-terminal-sharing-complete` is documented in
[the implemented contract](terminal-sharing.md). Native acceptance remains
[parent-coordinated and pending](terminal-sharing-native-qa.md).

Base: ThemePack `f868221b5f11810802f929369ac8eee46166079a`.
Branch: `feat/plugin-terminal-sharing`. This is saved unfinished source, not an
accepted API or an installable/native-tested workflow. Do not merge or release.

Implemented source so far:

- Canonical optional action-only `terminal.selection.read`, feature
  `terminal.selection-sharing`, bounded result and host-target schemas; SDK
  `context.terminals.shareSelection()` and runtime forwarding through the
  existing `ui.interact` broker. No independent parallel RPC stack.
- Main-only worker/session generation and window-owner binding accessor; no
  endpoint or Host DTO returned to plugins.
- Host target/handle authority, opaque signed short-lived receipts, capacity,
  expiry and lifecycle hooks; no selected text stored in the authority.
- Broker admission binding to the selected resource before a once-only grant,
  signed Preview/Share phases, fixed audit metadata and teardown integration.
- Trusted app-only selected-target setter, not a plugin API. No database,
  installation/source/cache identity or private-storage schema changes.

Still missing, and required before this counts as working:

1. Trusted renderer target publication for the real active terminal/workspace;
   actual bounded selection reader registered by the terminal surface. Read
   only on Preview, from a visible connected terminal, never through Agent/MCP
   history/context readers; refuse sensitive input, empty or oversized selection.
2. Host dialog Preview response and explicit Share rendering, failure states,
   exact resource/selection consistency and global lifecycle verification.
3. Canonical/SDK/broker/authority/real-worker/renderer normal and boundary tests,
   generated-contract and compatibility review (including optional-only
   declaration semantics), quotas, owner/reconnect/close/revoke/late-result cases.
4. Useful ordinary-browser synthetic example, fixture ID/hash/precise permissions,
   build/CI, independent review/fix/review and parent-owned native acceptance.
5. Separate input-draft layer: reuse the actual compose control without inheriting
   broadcast targets, overwriting an existing draft silently, writing PTY bytes
   or sending Enter. Require a separately approved target-bound draft action and
   final active identity check. No input-proposal method/permission is delivered
   by this WIP.

Known integration constraints:

- The market source-binding task owns installation, cache, authorization/private
  storage identity and associated database schema. Coordinate before touching
  those locations; runtime/assertActive identity must remain host-owned.
- Keep the ThemePack security-color delta in its own branch/head. Incorporate
  the eventually accepted head with a normal integration merge, not by rewriting
  frozen evidence.
- The user allows simplification of unreleased plugin historical data/protocols;
  do not add legacy migration layers. Do not remove unrelated host/input data
  migrations or weaken the sandbox.
