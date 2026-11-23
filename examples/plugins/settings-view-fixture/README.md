# Settings fixture

This example declares a standard host-owned greeting setting and a separate
modal preview page. Settings never render plugin HTML or CSS. It requests
`settings.read` for its own declared setting and `views` for the preview.
Build with `node build.mjs`; package `.package` using the plugin CLI.
