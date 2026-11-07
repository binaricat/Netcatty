export default {
  activate(context) {
    // The command runtime outlives its modal. Pagehide cleanup can lose view
    // sender authority, so keep the exact owned lease here until explicit Open
    // or Close replaces it. Core still validates source, expiry and duplicates.
    let chatHandle;
    let changes = Promise.resolve();
    const changeChat = (operation) => {
      const result = changes.then(operation); changes = result.catch(() => {}); return result;
    };
    const forget = (handle) => { if (chatHandle === handle) chatHandle = undefined; };
    const operations = { backends: 'listBackends', targets: 'selectTargets', chats: 'listChats', open: 'openChat',
      send: 'send', read: 'read', history: 'history', stop: 'stop', close: 'closeChat' };
    for (const [name, operation] of Object.entries(operations)) context.subscriptions.add(context.commands.registerCommand(
      `com.netcatty.globalagent.${name}`, (params = {}) => {
        if (name === 'open') return changeChat(async () => {
          if (chatHandle) {
            const previous = chatHandle;
            try { await context.agent.closeChat({ chatHandle: previous }); }
            catch (error) {
              // Missing/expired/revoked handles carry no current authority.
              // Fresh Open must independently authenticate and select again.
              // Preserve unknown failures for an explicit retry of this lease.
              if (error?.code !== 'permission_denied') throw error;
            }
            forget(previous);
          }
          const result = await context.agent.openChat(params); chatHandle = result.chatHandle; return result;
        });
        if (name === 'close') return changeChat(async () => {
          try { const result = await context.agent.closeChat(params); forget(params.chatHandle); return result; }
          catch (error) { if (error?.code === 'permission_denied') forget(params.chatHandle); throw error; }
        });
        return context.agent[operation](params);
      },
    ));
  },
};
