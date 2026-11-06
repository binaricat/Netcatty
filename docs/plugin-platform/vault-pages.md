# Vault extension pages

Declare `location: "vault-page"`, require `views.vault-pages`, and request the
`views` permission. Enabled entries appear in Vault's Extensions navigation,
with localized labels and host-resolved icons. Listing does not activate them.

Selecting an entry uses the built-in Vault rounded surface without an extra
plugin title bar. Netcatty draws the content itself; host menus and dialogs use
normal stacking. The plugin receives only the `netcatty.surface: vault-page`
context and its own interactions. Selection shares no Vault or session records.

Leaving and returning retains the view within the bounded lifecycle policy.
Missing/disabled entries, invalid context or failed activation return to Hosts.
Late failure from an older selection cannot replace a newer page. App Lock,
disable and runtime termination clear the associated content and authority.

See [host-rendered UI](./host-rendered-ui.md) for the single rendering contract,
resources, state retention and validation. `hello-vault`, `hello-world-v2`,
`hello-react-host` and `vault-scratchpad` demonstrate this placement. The scratchpad
saves only text entered in its own page, without creating a Vault Note.
