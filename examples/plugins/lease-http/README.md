# Synthetic credential lease fixture

This browser-only package exercises feature negotiation, plugin-owned secret
references, a one-use host-consumed network lease, and the host grant panel.
It contains only synthetic data and targets `https://example.invalid`.
A synthetic host test supplies the HTTP response. The normal app reports a
network failure at that deliberately non-routable address after permission.
This fixture does not prove a live third-party integration.

Pack the source after building the plugin packages:

```sh
node packages/plugin-cli/dist/cli.js pack examples/plugins/lease-http --out /tmp/lease-http.ncpkg
```

In the normal plugin manager, import the package disabled, inspect its declared
permissions, and enable it. The command palette contains **Synthetic credential
lease request**. Reject a permission prompt to verify that the request stops.
OS secret storage must be available to proceed past `secrets.set`.

The package detail's **Saved grants** panel shows retained decisions. One-use
decisions are not retained. **Disable and revoke all grants** disables the
plugin and waits for its runtime cleanup. Re-enable it to request access again.
Recent events show event type and permission without terminal or secret data.
Do not change the destination or substitute real credentials for this check.
