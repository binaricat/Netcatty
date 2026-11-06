import { definePlugin } from "@netcatty/plugin-sdk";

export default definePlugin({
  activate(context) {
    context.subscriptions.add(context.commands.registerCommand(
      "com.netcatty.starter.greet",
      async () => {
        const greeting = await context.settings.get<string>("com.netcatty.starter.greeting") ?? "Hello, synthetic world!";
        context.views.postMessage("com.netcatty.starter.panel", { greeting });
        return { greeting };
      },
    ));
  },
});
