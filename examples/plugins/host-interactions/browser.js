import { definePlugin, PLUGIN_HOST_INTERACTION_FEATURE } from '@netcatty/plugin-sdk';

export default definePlugin({
  activate(context) {
    context.subscriptions.add(context.commands.registerCommand('com.netcatty.host-interactions.text', async () => {
      if (!context.enabledFeatures.has(PLUGIN_HOST_INTERACTION_FEATURE)) throw new Error('Host interactions are unavailable');
      const source = await context.ui.quickPick('Choose a text workflow', [
        { id: 'compose', label: 'Compose synthetic text', description: 'Edit a draft, then explicitly confirm clipboard replacement.' },
        { id: 'share', label: 'Share clipboard and uppercase it', description: 'Preview text, confirm sharing, then confirm the transformed copy.' },
      ]);
      if (source === undefined) return { cancelled: true };
      const text = source === 'compose'
        ? await context.ui.input('Edit synthetic text', 'synthetic text')
        : await context.clipboard.readText('Share clipboard text for uppercase conversion');
      if (text === undefined) return { cancelled: true };
      const output = source === 'share' ? text.toUpperCase() : text;
      const copied = await context.clipboard.writeText(output, 'Confirm the exact text to copy');
      return { copied, characters: output.length };
    }));
  },
});
