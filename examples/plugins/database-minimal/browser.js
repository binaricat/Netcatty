import { CancellationTokenSource } from "@netcatty/plugin-sdk";
import { queryExample } from "./protocol.mjs";
import { endpoint } from "./fixture-config.mjs";

export default {
  activate(context) {
    let pending;
    const register = (suffix, handler) => context.subscriptions.add(context.commands.registerCommand(
      `com.netcatty.database-minimal.${suffix}`, handler,
    ));
    const cancel = () => { pending?.cancel(); return { cancelled: true }; };
    register("cancel", cancel);
    register("endpoint", () => ({ endpoint }));
    context.subscriptions.add({ dispose: cancel });
    register("query", async (args) => {
      if (pending) throw new Error("An example connection is already active");
      if (!args || Array.isArray(args) || Object.keys(args).some((key) => !["username", "password"].includes(key))
        || typeof args.username !== "string" || typeof args.password !== "string") throw new Error("Enter disposable fixture credentials");
      const cancellation = new CancellationTokenSource();
      pending = cancellation;
      let connection;
      try {
        connection = await context.network.connect({ endpoint }, cancellation.token);
        return await queryExample({ read: () => connection.readable.read(), write: (bytes) => connection.writable.write(bytes),
          close: () => connection.close() }, args.username, args.password);
      } finally {
        args.password = "";
        await connection?.close().catch(() => {});
        cancellation.dispose();
        pending = undefined;
      }
    });
  },
};
