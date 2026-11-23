export function mount(root, context, viewId) {
  const cleanup = [];
  const subscribeEnvironment = (listener) => { const sub = context.environment.onDidChange(listener); cleanup.push(() => sub.dispose()); listener(context.environment); return sub; };
  const subscribeMessage = (listener) => { const sub = context.views.onDidReceiveMessage(viewId, listener); cleanup.push(() => sub.dispose()); return sub; };
const button = root.querySelector("#" + 'greet');
const result = root.querySelector("#" + 'result');
let chinese = false;
subscribeEnvironment((environment) => {
  chinese = environment.locale.startsWith('zh');
  root.lang = chinese ? 'zh-CN' : 'en';
  root.style.colorScheme = environment.theme === 'light' ? 'light' : 'dark';
  root.querySelector("#" + 'title').textContent = chinese ? '你的第一个插件' : 'Your first plugin';
  root.querySelector("#" + 'description').textContent = chinese ? '读取并显示你设置的问候语。不访问主机、终端或秘密。' : 'Read your Greeting preference and show it here. No hosts, terminals or secrets are accessed.';
  button.textContent = chinese ? '显示问候语' : 'Show greeting';
});
subscribeMessage((message) => {
  if (typeof message?.greeting === 'string') result.textContent = message.greeting;
});
button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = chinese ? '正在读取…' : 'Reading…';
  try {
    const response = await context.commands.executeCommand('com.netcatty.starter.greet');
    result.textContent = response.greeting;
  } catch {
    result.textContent = chinese ? '未能读取问候语，请检查权限授权。' : 'Could not read the greeting. Check permission approval.';
  } finally {
    button.disabled = false;
  }
});

  return () => { for (const stop of cleanup) stop(); };
}
