# Read one disposable database row

This browser plugin tests the generic `network.byte-streams` feature and exact
`network.stream` permission. The database protocol and fixed SELECT query live
only in this example. The host transports bounded bytes.

Prepare a package for one private IPv4 fixture endpoint:

```sh
npm run build:plugin-runtime-deps
node examples/plugins/database-minimal/prepare.mjs tcp://10.77.0.20:3306 /tmp/database-example.ncpkg
node packages/plugin-cli/dist/cli.js validate /tmp/database-example.ncpkg
sha256sum /tmp/database-example.ncpkg
```

The address above is a packaging example. Preparation does not connect to it.
Use the actual disposable fixture address for native testing. A different
endpoint produces a different manifest, bundle, and package hash.

Import the package through Settings > Plugins, enable it, and open **Disposable
database example**. Enter only the fixture's session credentials. Deny the first
endpoint prompt, then retry and grant that exact endpoint. A successful read
shows `synthetic stream result`. **Cancel** stops the active operation.

The fixture must be reachable at a private address belonging to a different
machine or container, rather than an address assigned to the app's machine.
Loopback, the app machine's interface addresses, and mapped aliases remain
blocked. Do not replace the endpoint with a local SSH forwarding address.

The example supports protocol 4.1 and `mysql_native_password` over plain TCP.
Its server account needs only SELECT on `plugin_demo.example_result`. The query
is `SELECT value FROM plugin_demo.example_result LIMIT 1`. Server grants enforce
read-only access. The example does not support database TLS or STARTTLS.

Credentials are session-only and are not written to plugin settings, logs, or
secrets. JavaScript does not guarantee memory zeroization. The plugin has no
query editor, schema browser, or connection manager.

Follow [the native handoff](../../../docs/plugin-platform/byte-stream-native-qa.md)
for fixture prerequisites, screenshots, video, cancellation, and cleanup.
