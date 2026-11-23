import { CancellationTokenSource } from '@netcatty/plugin-sdk';
import { connectDatabase } from './protocol.mjs';

export default { activate(context) {
  let database;
  let pending;
  let stream;
  const disconnect = async () => {
    pending?.cancel();
    const current = stream;
    database = undefined; stream = undefined;
    await current?.close().catch(() => {});
    return { connected: false };
  };
  context.subscriptions.add({ dispose: () => { void disconnect(); } });
  const commands = {
    disconnect,
    async connect(args) {
      if (pending) throw new Error('A connection is already pending');
      if (!args || typeof args.endpoint !== 'string' || !args.endpoint.startsWith('tcp://')) throw new Error('Enter a tcp:// destination on the SSH server');
      await disconnect();
      const cancellation = new CancellationTokenSource(); pending = cancellation;
      try {
        const selection = await context.vault.selectHosts({ title: '请选择一个 SSH 服务器，用来连接数据库' });
        if (selection.cancelled) return { connected: false };
        if (selection.hosts.length !== 1) throw new Error('Select exactly one SSH server');
        const target = selection.hosts[0].target;
        const connection = await context.network.connectViaHost({ target, expectedRevision: target.revision, endpoint: args.endpoint }, cancellation.token);
        stream = connection;
        database = await connectDatabase({ read: () => connection.readable.read(), write: (bytes) => connection.writable.write(bytes), close: () => connection.close() }, args.username, args.password, args.database);
        return { connected: true, server: selection.hosts[0].metadata.label, endpoint: stream.endpoint };
      } catch (error) { await disconnect(); throw error; }
      finally { args.password = ''; cancellation.dispose(); pending = undefined; }
    },
    async query(args) {
      if (!database) throw new Error('Connect to a database first');
      const current = database;
      if (typeof args?.sql !== 'string' || args.sql.length > 32768) throw new Error('Invalid SQL');
      const review = await context.ui.quickPick('执行 SQL 可能修改数据；请确认当前语句', [{ id: 'execute', label: '执行当前 SQL', description: args.sql.slice(0, 256) }, { id: 'cancel', label: '取消' }]);
      if (review !== 'execute') return { cancelled: true };
      if (database !== current) throw new Error('The database connection changed');
      try { return await current.query(args.sql); }
      catch (error) { await disconnect(); throw error; }
    },
  };
  for (const [name, execute] of Object.entries(commands)) context.subscriptions.add(context.commands.registerCommand(`com.netcatty.database-host.${name}`, execute));
} };
