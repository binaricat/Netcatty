// This offline BrowserWindow plugin has no filesystem, network or credential
// permissions. Netcatty owns every picker, field diff and connection prompt.
export default {
  activate(context) {
    const select = () => context.vault.selectHosts({ title: 'Share saved host names, addresses, usernames, groups and tags' });
    const commands = {
      select,
      create: () => context.vault.requestHostDraft({ draft: {
        label: 'Synthetic SSH host', hostname: 'synthetic.invalid', username: 'example', group: 'Samples', tags: ['synthetic'],
      } }),
      edit: async () => {
        const selection = await select();
        if (selection.cancelled || selection.hosts.length === 0) return { cancelled: true };
        const host = selection.hosts[0];
        return context.vault.requestHostDraft({
          target: host.target, expectedRevision: host.target.revision,
          draft: { label: `${host.metadata.label} (reviewed)` },
        });
      },
      connect: async () => {
        const selection = await select();
        if (selection.cancelled || selection.hosts.length === 0) return { cancelled: true };
        const target = selection.hosts[0].target;
        return context.vault.requestConnect({ target, expectedRevision: target.revision });
      },
    };
    for (const [name, execute] of Object.entries(commands)) {
      context.subscriptions.add(context.commands.registerCommand(`com.netcatty.host-actions.${name}`, execute));
    }
  },
};
