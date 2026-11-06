export function mount(root, context, viewId, stateScope) {
  const cleanup = [];
const draft = root.querySelector("#" + "draft");
const status = root.querySelector("#" + "status");
let busy = false;
async function save(clear) {
  if (busy) return;
  busy = true;
  try {
    const text = clear ? "" : draft.value;
    await context.views.setState(viewId, stateScope, { version: 1, text });
    if (clear) draft.value = "";
    status.textContent = clear ? "Draft cleared." : "Draft saved in this plugin only.";
  } catch { status.textContent = "Could not save this draft."; }
  finally { busy = false; }
}
root.querySelector("#" + "save").addEventListener("click", () => { void save(false); });
root.querySelector("#" + "clear").addEventListener("click", () => { void save(true); });
context.views.getState(viewId, stateScope).then((state) => {
  if (state?.version === 1 && typeof state.text === "string" && state.text.length <= 4096) draft.value = state.text;
  status.textContent = "Ready. Use synthetic text for this example.";
  draft.disabled = false;
  root.querySelector("#" + "save").disabled = false;
  root.querySelector("#" + "clear").disabled = false;
}).catch(() => { status.textContent = "Could not load this plugin draft."; });

  return () => { for (const stop of cleanup) stop(); };
}
