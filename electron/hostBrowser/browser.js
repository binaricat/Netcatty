"use strict";

const api = window.hostBrowser;
const $ = (id) => document.getElementById(id);
let state = null;
let bookmarks = [];
let noticeTimer = null;
let editingTabId = null;
let editingBookmarkImageDataUrl = null;
let editingBookmarkMode = "website";
let editingBookmarkSiteIcon = null;

function showNotice(message) {
  const notice = $("notice");
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
}

async function command(type, extra = {}) {
  try {
    const next = await api.command({ type, ...extra });
    if (next) render(next);
    return true;
  } catch (error) { showNotice(error?.message || "Browser action failed"); }
  return false;
}

function syncChromeOverlay() {
  void command("set-overlay", { open: !$("tab-icon-menu").hidden || !$("tab-icon-editor").hidden });
}

function tabIcon(tab) {
  if (tab.iconDataUrl) {
    const image = document.createElement("img");
    image.className = "tab-favicon";
    image.src = tab.iconDataUrl;
    image.alt = "";
    return image;
  }
  const glyph = document.createElement("span");
  glyph.className = "tab-glyph";
  glyph.textContent = tab.iconGlyph || (tab.url ? "\u25cc" : "");
  if (tab.iconGlyph && tab.iconColor) glyph.style.color = tab.iconColor;
  return glyph;
}

function render(next) {
  const activeTabChanged = state?.activeTabId !== next.activeTabId;
  state = next;
  document.title = "Browser";
  document.body.dataset.embedded = String(Boolean(next.embedded));
  document.body.classList.toggle("dark", next.theme !== "light");
  for (const name of ["background", "foreground", "secondary", "muted", "muted-foreground", "border", "primary", "primary-foreground"]) {
    const value = next.themeTokens?.[name];
    if (typeof value === "string") document.body.style.setProperty(`--${name}`, value);
    else document.body.style.removeProperty(`--${name}`);
  }
  document.body.dataset.platform = next.platform;
  $("window-maximize").textContent = next.isMaximized ? "\u2750" : "\u25a1";
  $("window-maximize").title = next.isMaximized ? "Restore" : "Maximize";
  const connected = next.route === "connected";
  $("downloads-menu").setAttribute("aria-expanded", String(Boolean(next.downloadsPanelOpen)));
  const tabs = $("tabs");
  tabs.replaceChildren();
  for (const tab of next.tabs) {
    const item = document.createElement("div");
    item.className = `tab${tab.id === next.activeTabId ? " active" : ""}`;
    item.tabIndex = 0;
    item.setAttribute("role", "tab");
    item.setAttribute("aria-selected", String(tab.id === next.activeTabId));
    item.draggable = true;
    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", tab.id);
      event.dataTransfer.effectAllowed = "move";
      item.classList.add("dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("dragging"));
    item.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      const draggedId = event.dataTransfer.getData("text/plain");
      if (draggedId && draggedId !== tab.id) void command("reorder", { tabId: draggedId, beforeTabId: tab.id });
    });
    const icon = tabIcon(tab);
    if (tab.url) icon.title = "Right-click the tab to change its icon";
    item.append(icon);
    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || "New tab";
    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.title = "Close tab";
    close.textContent = "\u00d7";
    close.addEventListener("click", (event) => { event.stopPropagation(); void command("close-tab", { tabId: tab.id }); });
    item.addEventListener("click", () => void command("activate", { tabId: tab.id }));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void command("activate", { tabId: tab.id }); }
    });
    item.addEventListener("contextmenu", (event) => {
      if (!tab.url) return;
      event.preventDefault();
      editingTabId = tab.id;
      const menu = $("tab-icon-menu");
      menu.style.left = `${Math.min(event.clientX, window.innerWidth - 170)}px`;
      menu.style.top = `${Math.min(event.clientY, window.innerHeight - 90)}px`;
      menu.hidden = false;
      syncChromeOverlay();
    });
    item.append(title, close);
    tabs.append(item);
  }
  const active = next.tabs.find((tab) => tab.id === next.activeTabId);
  if (activeTabChanged || document.activeElement !== $("address")) $("address").value = active?.url || "";
  $("back").disabled = !connected || !active?.canGoBack;
  $("forward").disabled = !connected || !active?.canGoForward;
  $("reload").disabled = !connected || !active?.url;
  $("reload").title = active?.loading ? "Stop" : "Reload";
  $("reload").querySelector("path").setAttribute("d", active?.loading ? "M18 6 6 18M6 6l12 12" : "M20 11a8 8 0 1 0-2.3 6M20 4v7h-7");
  $("home").hidden = connected && Boolean(active?.url);
  $("connection-message").hidden = connected;
  $("apps-section").hidden = !connected;
  if (!connected) {
    $("home-description").textContent = next.error || "Reconnect to this host to continue browsing.";
    $("retry").hidden = next.route !== "disconnected";
  }
  renderBookmarks();
}

function bookmarkIcon(item) {
  const dataUrl = item.iconDataUrl || (item.iconMode === "custom" ? null : item.siteIconDataUrl);
  if (dataUrl) {
    const image = document.createElement("img");
    image.className = "app-icon image-icon";
    image.src = dataUrl;
    image.alt = "";
    return image;
  }
  const icon = document.createElement("span");
  icon.className = "app-icon";
  const custom = item.iconMode === "custom";
  icon.style.backgroundColor = !custom && item.siteIconGlyph ? item.siteIconColor : item.color;
  icon.textContent = !custom && item.siteIconGlyph ? item.siteIconGlyph : item.icon;
  return icon;
}

function renderBookmarks() {
  const appGrid = $("app-grid");
  const list = $("bookmark-list");
  appGrid.replaceChildren();
  list.replaceChildren();
  $("apps-empty").hidden = bookmarks.length > 0;
  for (const item of [...bookmarks].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))) {
    const tile = document.createElement("button");
    tile.className = "app-tile";
    tile.type = "button";
    tile.append(bookmarkIcon(item));
    const label = document.createElement("span");
    label.className = "app-name";
    label.textContent = item.title;
    tile.append(label);
    tile.title = item.url;
    tile.addEventListener("click", () => void command("navigate", { url: item.url }));
    appGrid.append(tile);

    const row = document.createElement("div");
    row.className = "bookmark-row";
    row.append(bookmarkIcon(item));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "bookmark-open";
    const title = document.createElement("span");
    title.textContent = item.title;
    const address = document.createElement("small");
    address.textContent = item.url;
    open.append(title, address);
    open.addEventListener("click", () => void command("navigate", { url: item.url }));
    row.append(open);
    const edit = document.createElement("button");
    edit.className = "icon-button";
    edit.title = "Edit";
    edit.textContent = "\u270e";
    edit.addEventListener("click", () => editBookmark(item));
    const remove = document.createElement("button");
    remove.className = "icon-button";
    remove.title = "Delete";
    remove.textContent = "\u00d7";
    remove.addEventListener("click", async () => {
      try { await api.removeBookmark(item.id); await refreshBookmarks(); }
      catch (error) { showNotice(error?.message || "Could not delete bookmark"); }
    });
    row.append(edit, remove);
    list.append(row);
  }
}

async function refreshBookmarks() {
  try {
    bookmarks = await api.listBookmarks();
    renderBookmarks();
  } catch (error) { showNotice(error?.message || "Could not load bookmarks"); }
}

function showBookmarkPanel(open) {
  $("bookmark-panel").hidden = !open;
  document.body.classList.toggle("bookmark-panel-open", open);
  if (!open) $("bookmark-form").hidden = true;
  void command("set-panel", { open });
}

function editBookmark(item = null) {
  showBookmarkPanel(true);
  $("bookmark-form").hidden = false;
  $("bookmark-id").value = item?.id || "";
  $("bookmark-title").value = item?.title || "";
  $("bookmark-url").value = item?.url || "";
  $("bookmark-icon").value = item?.iconMode === "custom" ? item.icon : "";
  $("bookmark-color").value = item?.color || "#247969";
  $("bookmark-scope").value = item?.scope || "host";
  $("bookmark-image").value = "";
  editingBookmarkImageDataUrl = item?.iconDataUrl || null;
  editingBookmarkSiteIcon = item?.siteIconDataUrl || null;
  $("bookmark-form-heading").textContent = item ? "Edit app" : "Add app";
  editingBookmarkMode = editingBookmarkImageDataUrl ? "image" : item?.iconMode === "custom" ? "text" : "website";
  $("bookmark-image-name").textContent = editingBookmarkImageDataUrl ? "Custom image saved" : "PNG, JPEG, WebP, GIF or ICO \u00b7 max 64 KB";
  renderBookmarkFormOptions();
  $("bookmark-title").focus();
}

function renderBookmarkFormOptions() {
  for (const button of document.querySelectorAll("[data-icon-mode]")) button.setAttribute("aria-pressed", String(button.dataset.iconMode === editingBookmarkMode));
  for (const button of document.querySelectorAll("[data-scope]")) button.setAttribute("aria-pressed", String(button.dataset.scope === $("bookmark-scope").value));
  $("bookmark-text-options").hidden = editingBookmarkMode !== "text";
  $("bookmark-image-options").hidden = editingBookmarkMode !== "image";
  const preview = $("bookmark-icon-preview");
  preview.replaceChildren();
  preview.classList.remove("image-icon");
  preview.style.backgroundColor = "";
  if (editingBookmarkMode === "image" && editingBookmarkImageDataUrl || editingBookmarkMode === "website" && editingBookmarkSiteIcon) {
    const image = document.createElement("img");
    image.src = editingBookmarkMode === "image" ? editingBookmarkImageDataUrl : editingBookmarkSiteIcon;
    image.alt = "";
    image.style.cssText = "width:100%;height:100%;object-fit:contain";
    preview.classList.add("image-icon");
    preview.append(image);
  } else {
    preview.style.backgroundColor = editingBookmarkMode === "text" ? $("bookmark-color").value : "hsl(var(--secondary))";
    preview.style.color = editingBookmarkMode === "text" ? "white" : "hsl(var(--muted-foreground))";
    preview.textContent = editingBookmarkMode === "text" ? ($("bookmark-icon").value || "A") : "\u25cc";
  }
  $("bookmark-color-swatch").style.backgroundColor = $("bookmark-color").value;
}

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/x-icon", "image/vnd.microsoft.icon"]);
function readImageFile(file) {
  if (!file) return Promise.resolve(null);
  if (!allowedImageTypes.has(file.type) || file.size > 64 * 1024) throw new Error("Choose a PNG, JPEG, WebP, GIF or ICO image under 64 KB");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

$("new-tab").addEventListener("click", () => void command("new-tab"));
$("window-minimize").addEventListener("click", () => void command("window-minimize"));
$("window-maximize").addEventListener("click", () => void command("window-maximize"));
$("window-close").addEventListener("click", () => void command("window-close"));
$("window-drag-region").addEventListener("dblclick", (event) => {
  if (!state?.embedded && state?.platform !== "darwin" && !event.target.closest("button, .tab")) void command("window-maximize");
});
$("retry").addEventListener("click", () => void command("retry"));
$("bookmarks-menu").addEventListener("click", () => {
  if (state?.downloadsPanelOpen) void command("set-download-panel", { open: false });
  showBookmarkPanel($("bookmark-panel").hidden);
});
$("downloads-menu").addEventListener("click", () => {
  if (!state?.downloadsPanelOpen && !$("bookmark-panel").hidden) showBookmarkPanel(false);
  void command("set-download-panel", { open: !state?.downloadsPanelOpen });
});
$("close-bookmarks").addEventListener("click", () => showBookmarkPanel(false));
$("add-bookmark").addEventListener("click", () => {
  const active = state?.tabs.find((tab) => tab.id === state.activeTabId);
  editBookmark();
  if (active?.url) {
    $("bookmark-title").value = active.title || new URL(active.url).hostname;
    $("bookmark-url").value = active.url;
  }
});
$("add-app").addEventListener("click", () => editBookmark());
$("bookmark-use-site-icon").addEventListener("click", () => {
  editingBookmarkMode = "website";
  editingBookmarkImageDataUrl = null;
  $("bookmark-image").value = "";
  $("bookmark-icon").value = "";
  renderBookmarkFormOptions();
});
for (const button of document.querySelectorAll("[data-icon-mode]")) button.addEventListener("click", () => {
  editingBookmarkMode = button.dataset.iconMode;
  renderBookmarkFormOptions();
});
for (const button of document.querySelectorAll("[data-scope]")) button.addEventListener("click", () => {
  $("bookmark-scope").value = button.dataset.scope;
  renderBookmarkFormOptions();
});
$("bookmark-icon").addEventListener("input", renderBookmarkFormOptions);
$("bookmark-color-button").addEventListener("click", () => $("bookmark-color").click());
$("bookmark-color").addEventListener("input", renderBookmarkFormOptions);
$("bookmark-choose-image").addEventListener("click", () => $("bookmark-image").click());
$("bookmark-image").addEventListener("change", async () => {
  const file = $("bookmark-image").files[0];
  if (!file) return;
  try {
    editingBookmarkImageDataUrl = await readImageFile(file);
    $("bookmark-image-name").textContent = file.name;
    renderBookmarkFormOptions();
  } catch (error) { $("bookmark-image").value = ""; showNotice(error?.message || "Could not read image"); }
});
$("bookmark-back").addEventListener("click", () => { $("bookmark-form").hidden = true; });
$("bookmark-close").addEventListener("click", () => showBookmarkPanel(false));
$("cancel-bookmark").addEventListener("click", () => { $("bookmark-form").hidden = true; });
$("bookmark-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const selectedImage = editingBookmarkMode === "image" ? await readImageFile($("bookmark-image").files[0]) : null;
    if (editingBookmarkMode === "image" && !selectedImage && !editingBookmarkImageDataUrl) throw new Error("Choose an image for this app");
    await api.saveBookmark({
      id: $("bookmark-id").value || undefined,
      title: $("bookmark-title").value,
      url: $("bookmark-url").value,
      icon: editingBookmarkMode === "text" ? $("bookmark-icon").value : "",
      iconMode: editingBookmarkMode === "website" ? "auto" : "custom",
      iconDataUrl: editingBookmarkMode === "image" ? selectedImage || editingBookmarkImageDataUrl : null,
      color: $("bookmark-color").value,
      scope: $("bookmark-scope").value,
      order: bookmarks.length,
    });
    $("bookmark-form").hidden = true;
    await refreshBookmarks();
  } catch (error) { showNotice(error?.message || "Could not save bookmark"); }
});

$("tab-icon-change").addEventListener("click", () => {
  $("tab-icon-menu").hidden = true;
  $("tab-icon-editor").hidden = false;
  const tab = state?.tabs.find((item) => item.id === editingTabId);
  $("tab-icon-text").value = tab?.iconGlyph || "";
  $("tab-icon-color").value = tab?.iconColor || "#247969";
  $("tab-icon-image").value = "";
  $("tab-icon-text").focus();
  syncChromeOverlay();
});
$("tab-icon-reset").addEventListener("click", () => {
  $("tab-icon-menu").hidden = true;
  syncChromeOverlay();
  void command("reset-icon", { tabId: editingTabId });
});
$("tab-icon-cancel").addEventListener("click", () => { $("tab-icon-editor").hidden = true; syncChromeOverlay(); });
$("tab-icon-editor-close").addEventListener("click", () => { $("tab-icon-editor").hidden = true; syncChromeOverlay(); });
$("tab-icon-save").addEventListener("click", async () => {
  try {
    const dataUrl = await readImageFile($("tab-icon-image").files[0]);
    const glyph = $("tab-icon-text").value.trim();
    if (!dataUrl && !glyph) throw new Error("Enter icon text or choose an image");
    if (await command("set-icon", { tabId: editingTabId, dataUrl, glyph, color: $("tab-icon-color").value })) {
      $("tab-icon-editor").hidden = true;
      syncChromeOverlay();
    }
  } catch (error) { showNotice(error?.message || "Could not save icon"); }
});
document.addEventListener("click", (event) => {
  if (!$("tab-icon-menu").hidden && !$("tab-icon-menu").contains(event.target)) {
    $("tab-icon-menu").hidden = true;
    syncChromeOverlay();
  }
});

$("back").addEventListener("click", () => void command("back"));
$("forward").addEventListener("click", () => void command("forward"));
$("reload").addEventListener("click", () => {
  const active = state?.tabs.find((tab) => tab.id === state.activeTabId);
  void command(active?.loading ? "stop" : "reload");
});
$("address-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void command("navigate", { url: $("address").value });
  $("address").blur();
});
document.addEventListener("keydown", (event) => {
  const modifier = navigator.platform.includes("Mac") ? event.metaKey : event.ctrlKey;
  if (!modifier) return;
  if (event.key.toLowerCase() === "l") { event.preventDefault(); $("address").focus(); $("address").select(); }
  if (event.key.toLowerCase() === "t") { event.preventDefault(); void command("new-tab"); }
  if (event.key.toLowerCase() === "w") { event.preventDefault(); void command("close-tab"); }
  if (event.key.toLowerCase() === "r") { event.preventDefault(); void command("reload"); }
});
api.onState(render);
api.onBookmarksChanged(() => void refreshBookmarks());
api.onSiteIconsChanged(() => void refreshBookmarks());
api.onDownloadsChanged((downloads) => $("downloads-menu").classList.toggle("has-active", downloads.some((item) => ["waiting", "progressing"].includes(item.status))));
api.onShortcut(({ type, tabId }) => {
  if (type === "focus-address") { $("address").focus(); $("address").select(); }
  else void command(type, { tabId });
});
void api.snapshot().then(render).catch((error) => showNotice(error?.message || "Browser unavailable"));
void refreshBookmarks();
void api.listDownloads().then((downloads) => $("downloads-menu").classList.toggle("has-active", downloads.some((item) => ["waiting", "progressing"].includes(item.status)))).catch(() => {});
