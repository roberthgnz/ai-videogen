/* Stored secrets never cross IPC back to this local settings window. */
const invoke = window.__TAURI__.core.invoke;
const keys = ["ANTHROPIC_API_KEY", "FISH_AUDIO_API_KEY", "ELEVENLABS_API_KEY", "PIXABAY_API_KEY"];
const names = ["Anthropic", "Fish Audio", "ElevenLabs", "Pixabay"];
const fields = document.getElementById("providers");
const status = document.getElementById("status");
for (let index = 0; index < keys.length; index++) {
  const label = document.createElement("label");
  label.textContent = names[index];
  const input = document.createElement("input");
  input.type = "password";
  input.id = keys[index];
  input.autocomplete = "new-password";
  input.placeholder = nativeText("Not configured");
  input.maxLength = 4000;
  label.append(input);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = nativeText("Remove key");
  nativeLanguageReady.then(() => { remove.textContent = nativeText("Remove key"); });
  remove.addEventListener("click", async () => {
    if (!window.confirm(nativeText("Remove the {0} key?", names[index]))) return;
    try { await invoke("save_credential", { key: keys[index], value: "" }); input.value = ""; await refresh(); status.textContent = nativeText("Key removed. Restart to apply the change."); }
    catch { status.textContent = nativeText("Could not remove the key."); }
  });
  label.append(remove);
  fields.append(label);
}
async function refresh() {
  const configured = await invoke("credential_status");
  configured.forEach((value, index) => { document.getElementById(keys[index]).placeholder = nativeText(value ? "Configured · enter a new key to replace it" : "Not configured"); });
}
document.getElementById("credentials").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    for (const key of keys) {
      const field = document.getElementById(key);
      if (field.value.trim()) { await invoke("save_credential", { key, value: field.value }); field.value = ""; }
    }
    await refresh();
    status.textContent = nativeText("Changes saved. Restart to apply them.");
  } catch { status.textContent = nativeText("Could not save all changes. Try again."); }
  finally { button.disabled = false; }
});
document.getElementById("restart").addEventListener("click", () => {
  if (window.confirm(nativeText("Restart VideoGen? Active jobs will stop."))) invoke("restart_app");
});
document.getElementById("import").addEventListener("click", async () => {
  try {
    const count = await invoke("import_credentials");
    await refresh();
    status.textContent = count ? nativeText("Imported {0} keys into secure storage. Restart to apply them.", count) : nativeText("No keys were imported.");
  } catch { status.textContent = nativeText("Could not import the keys."); }
});
nativeLanguageReady.then(refresh).catch(() => { status.textContent = nativeText("Could not access secure storage."); });
