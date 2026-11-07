# Plugin UI prior art

Research date: 2026-10-29. Supplement to the host-drawn UI design. Preserve the
existing prototype and its test evidence. This is a new, unpublished feature;
legacy view compatibility and migration are not requirements.

## Source comparison

| Reference | Verified design | What Netcatty can use |
| --- | --- | --- |
| [Shopify Remote DOM](https://github.com/Shopify/remote-dom) | Synchronizes a UI tree from a separate JavaScript environment into host-owned DOM. Includes worker/polyfill and React examples. Its current receiver supports explicit element/member restrictions. | The existing prototype's host-drawn direction. Treat Remote DOM as transport/rendering machinery, not a complete plugin sandbox. |
| [VS Code web extensions](https://code.visualstudio.com/api/extension-guides/web-extensions) | Web extensions run in the browser extension host, lack Node APIs, and use VS Code APIs. They still have broad VS Code API access. | Separation of extension execution from application UI and explicit host APIs. The absence of Node alone does not imply no access to user files. |
| [Joplin plugin architecture](https://joplinapp.org/help/dev/spec/plugins/) | Desktop plugin scripts run in a separate process with a proxy carrying API calls and events to the host. Its [custom panels](https://joplinapp.org/api/references/plugin_api/classes/joplinviewspanels.html) display HTML in webviews. | Independent plugin lifecycle and message-based APIs. Its panel display approach does not meet the requested host-drawn UI design. Process separation primarily helps containment and stability; permission safety depends on exposed APIs. |
| [Obsidian plugin security](https://help.obsidian.md/Extending+Obsidian/Plugin+security) | Official documentation explicitly says plugins inherit the app's access levels and cannot reliably be restricted to individual permissions. Plugins can access files and the internet. | A reference for integration experience, not the requested data-isolation policy. This comparison concerns published plugin documentation, not an audit of open-source application internals. Obsidian's application core must not be presented as an open-source reference merely because its plugin API and examples are public. |
| [Logseq official samples](https://github.com/logseq/logseq-plugin-samples) | Public examples cover custom themes, toolbar/editor interactions and custom pages. The [Hello World entry](https://github.com/logseq/logseq-plugin-samples/blob/master/logseq-hello-world/index.html) is an HTML document loading a plugin SDK and script. | Useful extension-point examples. These samples alone do not establish a security boundary or prove plugins cannot access user data; no such assurance is inferred here. |

## Important security distinction

In the [Remote DOM security discussion](https://github.com/Shopify/remote-dom/discussions/587),
the implementation explanation describes an intermediate data tree, property
allowlists and reprojection before trusted DOM changes. It explicitly warns
against directly applying arbitrary remote patches. This is consistent with the
existing Netcatty prototype's validation-before-rendering approach; it is not a
reason to discard or rebuild that prototype.

The framework supports host-controlled UI elements, but its common examples use
restricted custom components. Netcatty's broader HTML/CSS freedom is an additional
product/security design responsibility, not a guarantee supplied by Shopify.

## Design consequence

Continue from the implemented host-drawn prototype. Keep developer freedom over
ordinary layout, typography, colors and component composition. Independently
control executable content, external resources, global positioning, host data
access and event payloads. UI permission must not implicitly grant file,
terminal, credential, clipboard or network access.

Retain the completed prototype tests as evidence of their specific scenarios.
They are not proof of unrestricted React-library compatibility, complete UI
lifecycle correctness or immunity to malicious plugins. The remaining work is
to finish these boundaries and interaction semantics, with one intended UI
architecture and no compatibility path for the unpublished alternatives.
