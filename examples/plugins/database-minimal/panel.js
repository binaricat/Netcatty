export function mount(root, context) {
  const cleanup = [];
const username = root.querySelector("#" + "username");
const password = root.querySelector("#" + "password");
const query = root.querySelector("#" + "query");
const cancel = root.querySelector("#" + "cancel");
const result = root.querySelector("#" + "result");
const command = (suffix, args) => context.commands.executeCommand(`com.netcatty.database-minimal.${suffix}`, args);
void command("endpoint").then((value) => { root.querySelector("#" + "endpoint").textContent = value.endpoint; });
root.querySelector("#" + "form").addEventListener("submit", async (event) => {
  event.preventDefault();
  query.disabled = true;
  cancel.disabled = false;
  result.textContent = "Connecting to the disposable fixture…";
  const credentials = { username: username.value, password: password.value };
  password.value = "";
  try {
    const response = await command("query", credentials);
    result.textContent = JSON.stringify(response, null, 2);
  } catch { result.textContent = "Connection or read failed. Check the fixture, exact endpoint grant, and session credentials."; }
  finally { credentials.password = ""; query.disabled = false; cancel.disabled = true; }
});
cancel.addEventListener("click", async () => {
  cancel.disabled = true;
  try { await command("cancel"); result.textContent = "Example connection cancelled."; }
  catch { result.textContent = "Could not cancel the example connection."; }
});

  return () => { for (const stop of cleanup) stop(); };
}
