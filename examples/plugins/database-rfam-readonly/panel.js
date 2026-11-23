export function mount(root, context) {
  const cleanup = [];
const query = root.querySelector("#" + "query");
const cancel = root.querySelector("#" + "cancel");
const result = root.querySelector("#" + "result");
const command = (suffix) => context.commands.executeCommand(`com.netcatty.database-rfam-readonly.${suffix}`);
void command("endpoint").then((value) => { root.querySelector("#" + "endpoint").textContent = value.endpoint; });
query.addEventListener("click", async () => {
  query.disabled = true;
  cancel.disabled = false;
  result.textContent = "Requesting the exact public endpoint…";
  try { result.textContent = JSON.stringify(await command("query"), null, 2); }
  catch { result.textContent = "Public sample failed. Authentication, TLS requirements, and service reachability may be unsupported. No fallback is attempted."; }
  finally { query.disabled = false; cancel.disabled = true; }
});
cancel.addEventListener("click", async () => {
  cancel.disabled = true;
  try { await command("cancel"); result.textContent = "Public sample cancelled."; }
  catch { result.textContent = "Could not cancel the public sample."; }
});

  return () => { for (const stop of cleanup) stop(); };
}
