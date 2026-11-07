// Ordinary browser runtime. The host SDK supplies the only privileged surface.
export default {
  activate(context) {
    const register = (name, handler) => context.subscriptions.add(context.commands.registerCommand(
      `com.netcatty.assistant.${name}`, handler,
    ));
    register('open', () => context.ai.openChat({}));
    register('contexts', async () => (await context.selectedContext.list({})).items);
    register('send', (params) => context.ai.startTurn(params));
    register('read', (params) => context.ai.readTurn(params));
    register('stop', (params) => context.ai.stopTurn(params));
    register('close', (params) => context.ai.closeChat(params));
  },
};
