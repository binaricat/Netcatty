export function mount(root, context, viewId) {
  const cleanup = [];
  const onDispose = (stop) => cleanup.push(stop);
  const subscribeMessage = (listener) => { const sub = context.views.onDidReceiveMessage(viewId, listener); cleanup.push(() => sub.dispose()); return sub; };
const element = (id) => root.querySelector("#" + id);
const invoke = (name, params = {}) => context.commands.executeCommand(`com.netcatty.globalagent.${name}`, params);
let chat; let selection; let turn; let busy = false; let generation = 0; let closed = false;
const option = (value, text) => { const item = root.ownerDocument.createElement('option'); item.value = value; item.textContent = text; return item; };
const status = (text) => { element('status').textContent = text; };
function controls(value) {
  busy = value;
  for (const id of ['backend', 'conversation', 'refresh', 'targets', 'prompt']) element(id).disabled = value;
  element('open').disabled = value || !selection || !element('backend').value;
  element('send').disabled = value || !chat;
  element('stop').disabled = !value || !chat;
}
async function closeChat() { const previous = chat; chat = undefined; if (previous) await invoke('close', { chatHandle: previous.chatHandle }).catch(() => {}); }
async function refresh() {
  if (busy || closed) return; const run = ++generation; controls(true);
  try {
    await closeChat();
    const [backends, chats] = await Promise.all([invoke('backends'), invoke('chats')]);
    if (closed || run !== generation) return;
    element('backend').replaceChildren(...backends.items.map((item) => {
      const entry = option(item.status === 'supported' ? item.backendRef : '', `${item.label}${item.status === 'supported' ? '' : ` (${item.status}: ${item.reason})`}`);
      entry.disabled = item.status !== 'supported'; return entry;
    }));
    const supported = backends.items.find((item) => item.status === 'supported'); element('backend').value = supported?.backendRef ?? '';
    element('conversation').replaceChildren(option('', 'New conversation'), ...chats.items.map((item) => option(item.conversationRef, `${item.title} · ${item.backend}`)));
    status('Choose terminals, then open a conversation.');
  } catch { if (!closed && run === generation) status('Configured Agent unavailable. Check Netcatty settings, then Refresh backends.'); }
  finally { if (!closed && run === generation) controls(false); }
}
element('refresh').addEventListener('click', refresh);
for (const id of ['backend', 'conversation']) element(id).addEventListener('change', async () => { await closeChat(); controls(false); status('Open the selected conversation before sending.'); });
element('targets').addEventListener('click', async () => {
  if (busy) return; const run = ++generation; controls(true);
  try {
    await closeChat(); const result = await invoke('targets');
    if (closed || run !== generation) return; selection = result;
    element('selection').textContent = result.items.length ? result.items.map((item) => item.title).join(', ') : 'No terminal targets. Model conversation only.';
    status('Targets selected. Open a conversation.');
  } catch { if (!closed && run === generation) status('Target selection ended. Choose terminals again when ready.'); }
  finally { if (!closed && run === generation) controls(false); }
});
element('open').addEventListener('click', async () => {
  if (busy || !selection) return;
  if (selection.expiresAt <= Date.now()) { status('Target selection expired. Choose terminals again.'); return; }
  const run = ++generation; controls(true);
  try {
    await closeChat(); const reference = element('conversation').value;
    const result = await invoke('open', { backendRef: element('backend').value, selectionHandle: selection.selectionHandle, ...(reference ? { conversationRef: reference } : {}) });
    if (closed || run !== generation) { await invoke('close', { chatHandle: result.chatHandle }).catch(() => {}); return; }
    chat = result; const history = await invoke('history', { chatHandle: chat.chatHandle });
    if (closed || run !== generation) return;
    element('transcript').textContent = history.items.map((item) => `${item.role}: ${item.text}`).join('\n\n');
    element('usage').textContent = ''; element('activity').textContent = '';
    status(`Ready · ${result.backendLabel}`);
  } catch { await closeChat(); if (!closed && run === generation) status('Conversation unavailable. Refresh backends or choose terminals again; your draft is kept.'); }
  finally { if (!closed && run === generation) controls(false); }
});
element('compose').addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy || !chat || !element('prompt').value.trim()) return;
  if (chat.expiresAt <= Date.now()) { status('Conversation targets expired. Choose terminals and reopen; your draft is kept.'); return; }
  const run = ++generation; controls(true); status('Running…'); element('usage').textContent = ''; element('activity').textContent = '';
  const text = element('prompt').value; element('transcript').textContent += `\n\nuser: ${text}\n\nassistant: `;
  try {
    const result = await invoke('send', { chatHandle: chat.chatHandle, text });
    if (closed || run !== generation) { await invoke('stop', { turnHandle: result.turnHandle }).catch(() => {}); return; }
    turn = result.turnHandle;
    for (;;) {
      const item = await invoke('read', { turnHandle: turn }); if (closed || run !== generation) return;
      if (item.kind === 'end') { status(item.reason === 'completed' ? 'Complete' : `Ended: ${item.reason}`); break; }
      if (item.kind === 'text') element('transcript').textContent += item.text;
      if (item.kind === 'activity') element('activity').textContent = `${item.capabilityId}: ${item.state}`;
      if (item.kind === 'usage') element('usage').textContent = `${item.inputTokens} input tokens · ${item.outputTokens} output tokens`;
    }
  } catch { if (!closed && run === generation) status('Request ended. Check access or refresh/reselect before another explicit Send; your draft is kept.'); }
  finally { if (!closed && run === generation) { turn = undefined; controls(false); } }
});
element('stop').addEventListener('click', async () => {
  if (!busy) return; const run = ++generation; const previous = turn; turn = undefined; status('Stopping…');
  try { if (previous) await invoke('stop', { turnHandle: previous }); else await closeChat(); }
  catch { /* Revocation may already have stopped this exact turn. */ }
  finally { if (!closed && run === generation) { controls(false); status('Stopped'); } }
});
subscribeMessage?.((message) => { if (message?.qaFixture === true) element('qa').textContent = 'Isolated deterministic fixture · no real model inference or paid API'; });
onDispose( () => { closed = true; ++generation;  if (turn) void invoke('stop', { turnHandle: turn }).catch(() => {}); void closeChat(); });
void refresh();

  return () => { for (const stop of cleanup) stop(); };
}
