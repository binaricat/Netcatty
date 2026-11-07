import { CancellationTokenSource } from "@netcatty/plugin-sdk";
import { queryRfamReadOnly } from "../database-minimal/protocol.mjs";

const endpoint = "tcp://mysql-rfam-public.ebi.ac.uk:4497";
export default {
  activate(context) {
    let pending;
    const register = (suffix, handler) => context.subscriptions.add(context.commands.registerCommand(
      `com.netcatty.database-rfam-readonly.${suffix}`, handler,
    ));
    const cancel = () => { pending?.cancel(); return { cancelled: true }; };
    register("cancel", cancel);
    register("endpoint", () => ({ endpoint }));
    context.subscriptions.add({ dispose: cancel });
    register("query", async (args) => {
      if (args !== undefined && args !== null) throw new Error("The public sample accepts no query or credential parameters");
      if (pending) throw new Error("A public sample request is already active");
      const cancellation = new CancellationTokenSource();
      pending = cancellation;
      let connection;
      try {
        connection = await context.network.connect({ endpoint }, cancellation.token);
        return await queryRfamReadOnly({
          read: () => connection.readable.read(), write: (bytes) => connection.writable.write(bytes),
          close: () => connection.close(),
        });
      } finally {
        await connection?.close().catch(() => {});
        cancellation.dispose();
        pending = undefined;
      }
    });
  },
};
