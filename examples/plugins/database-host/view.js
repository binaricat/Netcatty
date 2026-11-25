export function mount(root, context) {
  const find = (id) => root.querySelector(`#${id}`);
  const command = (name, args) => context.commands.executeCommand(`com.netcatty.database-host.${name}`, args);
  let connected = false;
  find('connect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const args = Object.fromEntries(['endpoint', 'database', 'username', 'password'].map((key) => [key, find(key).value]));
    find('password').value = ''; find('connect').disabled = true; find('execute').disabled = true;
    find('status').textContent = '正在选择服务器或连接…';
    try {
      const result = await command('connect', args);
      connected = result.connected;
      find('status').textContent = connected ? `已连接：${result.server} → ${result.endpoint}` : '已取消连接';
    } catch { connected = false; find('status').textContent = '连接失败，请检查服务器、地址、账号和数据库认证方式。'; }
    finally { args.password = ''; find('connect').disabled = false; find('execute').disabled = !connected; }
  });
  find('query-form').addEventListener('submit', async (event) => {
    event.preventDefault(); find('execute').disabled = true;
    try {
      const text = JSON.stringify(await command('query', { sql: find('sql').value }), null, 2);
      find('result').textContent = text.length > 7500 ? `${text.slice(0, 7500)}\n结果较长，仅显示前面部分；请缩小查询范围。` : text;
    }
    catch { connected = false; find('status').textContent = '查询未完成，连接已关闭。请检查权限或缩小结果范围后重新连接；修改语句不会自动重试。'; }
    finally { find('execute').disabled = !connected; }
  });
  find('disconnect').addEventListener('click', async () => {
    await command('disconnect'); connected = false; find('execute').disabled = true; find('status').textContent = '已断开';
  });
  return () => { void command('disconnect').catch(() => {}); };
}
