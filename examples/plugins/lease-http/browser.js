import { definePlugin, PLUGIN_NETWORK_CREDENTIAL_LEASE_FEATURE } from '@netcatty/plugin-sdk';

// Isolated acceptance fixture: the target is deliberately non-routable.
// Tests provide a synthetic HTTP transport. Never substitute a real credential.
export default definePlugin({
  activate(context) {
    context.subscriptions.add(context.commands.registerCommand('com.netcatty.lease-http.request', async () => {
      if (!context.enabledFeatures.has(PLUGIN_NETWORK_CREDENTIAL_LEASE_FEATURE)) {
        throw new Error('Host does not advertise network credential leases');
      }
      const secret = await context.secrets.set('synthetic-token', 'synthetic-acceptance-token');
      const credentialLease = await context.credentials.createLease(secret, {
        operationId: 'network:https://example.invalid',
        purpose: 'Authenticate an isolated synthetic request',
      });
      const response = await context.network.request({
        url: 'https://example.invalid/synthetic',
        credentialLease,
        authorization: { scheme: 'Bearer' },
      });
      return { status: response.status };
    }));
  },
});
