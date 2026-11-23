export function mount(root, context) {
  const cleanup = [];
  const subscribeEnvironment = (listener) => { const sub = context.environment.onDidChange(listener); cleanup.push(() => sub.dispose()); listener(context.environment); return sub; };
(() => {
  let locale = 'en';
  let count = 0;
  const text = {
    en: ['Hello, world!', 'A small plugin page that feels at home in Netcatty.', 'Try it out', 'This example only changes what you see here.', 'Say hello'],
    'zh-CN': ['你好，世界！', '一个融入 Netcatty 的简单插件页面。', '试一试', '这个示例只会改变当前页面上的内容。', '打个招呼'],
  };
  const update = () => {
    const zh = locale.startsWith('zh');
    const words = text[zh ? 'zh-CN' : 'en'];
    root.lang = zh ? 'zh-CN' : 'en';
    ['title', 'description', 'card-title', 'card-description', 'button'].forEach((id, i) => { root.querySelector("#" + id).textContent = words[i]; });
    root.querySelector("#" + 'result').textContent = count ? (zh ? `你好！已打招呼 ${count} 次。` : `Hello! You said hello ${count} ${count === 1 ? 'time' : 'times'}.`) : '';
  };
  root.querySelector("#" + 'button').addEventListener('click', () => { count++; update(); });
  subscribeEnvironment((environment) => { locale = environment.locale || 'en'; update(); });
  update();
})();

  return () => { for (const stop of cleanup) stop(); };
}
