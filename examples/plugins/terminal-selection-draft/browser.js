import { definePlugin } from '@netcatty/plugin-sdk';

export default definePlugin({
  activate(context) {
    let reference;
    context.subscriptions.add(context.commands.registerCommand('com.netcatty.terminal-selection-draft.share', async () => {
      reference = undefined;
      const selection = await context.terminals.shareSelection('Review the exact terminal selection');
      if (selection === undefined) return { cancelled: true };
      reference = { handle: selection.handle };
      return { sharedCharacters: selection.text.length };
    }));
    context.subscriptions.add(context.commands.registerCommand('com.netcatty.terminal-selection-draft.review', async () => {
      if (!reference) throw new Error('Share a terminal selection first');
      // Synthetic proposal only. Stale references fail without a reread or retry.
      const reviewed = await context.terminals.proposeInput(reference.handle, "printf 'synthetic draft only'", 'Review an editable synthetic draft');
      return { reviewed };
    }));
  },
});
