import { definePlugin } from "@netcatty/plugin-sdk";

export default definePlugin({
  activate(context) {
    const register = (suffix, handler) => context.subscriptions.add(context.commands.registerCommand(
      `com.example.local-logging-fixture.${suffix}`, handler,
    ));
    register("emit", () => {
      context.logger.info("Synthetic diagnostic for local logging QA", {
        apiKey: "SYNTHETIC-API-KEY-NOT-A-CREDENTIAL",
        prompt: "SYNTHETIC-PROMPT-BODY",
        Notes: "SYNTHETIC-NOTE-BODY",
        SQL: "SYNTHETIC-SQL-BODY",
        results: "SYNTHETIC-RESULT-BODY",
        terminalContent: "SYNTHETIC-TERMINAL-BODY",
        pluginId: "synthetic-spoofed-plugin",
        sourceId: "official",
        runtimeId: "synthetic-spoofed-runtime",
      });
      return { ok: true, synthetic: true };
    });
    register("noise", () => {
      for (let index = 0; index < 400; index++) console.info(`Synthetic diagnostic burst ${index}`);
      return { ok: true, synthetic: true, emitted: 400 };
    });
    register("denied", async () => {
      // No network permission is declared. The host must reject before any
      // network I/O or approval prompt; no body or credential is ever supplied.
      try {
        await context.network.request({ method: "GET", url: "https://logging-fixture.example.com/should-never-be-sent" });
        throw new Error("Synthetic undeclared request unexpectedly succeeded");
      } catch (error) {
        if (error?.code !== "permission_denied" && error?.code !== -32007) throw error;
        return { denied: true, synthetic: true };
      }
    });
  },
});
