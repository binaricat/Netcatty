# Host text workflow

This browser-only fixture uses host choice/input dialogs and explicit clipboard
copy/share. It has no network, filesystem, host/session, credential, Node, or
shell permission. Shared text stays in the current operation's memory and is
not returned in the command result or written to plugin storage/logs.

Version 0.1.1 requires `host.interactions` and `commands.interactive`. Its one
command explicitly declares the fixed 180-second interactive budget; ordinary
commands keep 30 seconds and each dialog keeps 60 seconds. The host closes
pending confirmations when the command fails or ends, without resetting quotas.
These features add no new data permission. The permission list remains
required `commands`/`menus`, optional `ui.interact`/`clipboard.read`/`clipboard.write`.

Pack the source after building the plugin packages:

```sh
node packages/plugin-cli/dist/cli.js pack examples/plugins/host-interactions --out /tmp/host-interactions.ncpkg
```

Import it disabled in the normal manager. Inspect permissions before enabling.
Use one-use permissions for this check. With the unlocked main window focused,
choose **Host text workflow** in the command palette.

- **Compose synthetic text** asks for text and then previews the exact clipboard
  replacement. Cancel leaves the clipboard unchanged.
- **Share clipboard and uppercase it** first asks before reading the clipboard.
  The host previews the captured text and requires a second confirmation to
  share it with the plugin. The transformed output needs a separate copy
  confirmation. Clipboard changes after preview do not change the shared
  snapshot.

Use only synthetic clipboard text. Do not use account data or real secrets.
The fixture does not require a persistent grant or any network destination.
A different plugin that also has network permission could send shared text
through its granted capabilities; reading text does not approve a new origin.

Blur/lock/close the owner window, cancel, revoke access, or disable the plugin
to end a pending request. Late/duplicate replies cannot commit an old action.
Only the focused unlocked main window is supported in this first slice. Other
windows return unavailable instead of inheriting the request's authority.
