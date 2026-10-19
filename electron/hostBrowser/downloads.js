"use strict";

const api = window.hostBrowserDownloads;
const $ = (id) => document.getElementById(id);
const icons = {
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3zM3 11h18"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  cancel: '<path d="M18 6 6 18M6 6l12 12"/>',
};
let items = [];
let noticeTimer = null;

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.innerHTML = icons[name];
  return svg;
}

function showNotice(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 4000);
}

async function action(type, id) {
  try { await api.command(type, id); }
  catch (error) { showNotice(error?.message || "Download action failed"); }
}

function size(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function statusText(item) {
  if (item.missing) return "File moved or deleted";
  if (item.status === "waiting") return "Preparing download\u2026";
  if (item.status === "progressing") return item.total
    ? `${size(item.received)} of ${size(item.total)} \u00b7 ${Math.min(100, Math.round(item.received * 100 / item.total))}%`
    : `${size(item.received)} \u00b7 Downloading\u2026`;
  if (item.status === "completed") return `${size(item.total || item.received)} \u00b7 Completed`;
  if (item.status === "cancelled") return "Cancelled";
  return "Interrupted";
}

function button(name, title, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "icon-button";
  element.title = title;
  element.setAttribute("aria-label", title);
  element.append(icon(name));
  element.addEventListener("click", onClick);
  return element;
}

function render(downloads) {
  items = Array.isArray(downloads) ? downloads : [];
  $("download-list").replaceChildren();
  $("empty").hidden = items.length > 0;
  $("footer").hidden = !items.some((item) => !["waiting", "progressing"].includes(item.status));
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "download-row";
    const file = document.createElement("span");
    file.className = "file-icon";
    file.append(icon("file"));
    const detail = document.createElement("div");
    detail.className = "download-detail";
    const filename = document.createElement("span");
    filename.className = "filename";
    filename.textContent = item.filename;
    filename.title = item.filename;
    const status = document.createElement("span");
    status.className = `download-status${item.missing ? " missing" : item.status === "interrupted" ? " interrupted" : ""}`;
    status.textContent = statusText(item);
    detail.append(filename, status);
    if (item.status === "progressing") {
      const track = document.createElement("div");
      track.className = "progress-track";
      const fill = document.createElement("div");
      fill.className = "progress-fill";
      fill.style.width = `${item.total ? Math.min(100, item.received * 100 / item.total) : 12}%`;
      track.append(fill);
      detail.append(track);
    }
    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (item.status === "completed" && !item.missing) {
      actions.append(button("folder", "Show in folder", () => void action("reveal", item.id)));
    } else if (["waiting", "progressing"].includes(item.status)) {
      actions.append(button("cancel", "Cancel download", () => void action("cancel", item.id)));
    }
    const more = button("more", "More actions", (event) => {
      event.stopPropagation();
      document.querySelectorAll(".row-menu").forEach((menu) => { if (menu !== actionMenu) menu.hidden = true; });
      actionMenu.hidden = !actionMenu.hidden;
    });
    const actionMenu = document.createElement("div");
    actionMenu.className = "row-menu";
    actionMenu.hidden = true;
    const addMenuAction = (label, type) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = label;
      choice.addEventListener("click", () => { actionMenu.hidden = true; void action(type, item.id); });
      actionMenu.append(choice);
    };
    if (item.status === "completed" && !item.missing) addMenuAction("Open file", "open");
    if (item.status === "completed" && !item.missing) addMenuAction("Save as\u2026", "save-as");
    if (!["waiting", "progressing"].includes(item.status)) addMenuAction("Remove from list", "remove");
    if (actionMenu.childElementCount) actions.append(more);
    row.append(file, detail, actions, actionMenu);
    $("download-list").append(row);
  }
}

function applyTheme(next) {
  document.body.classList.toggle("dark", next?.theme !== "light");
  for (const name of ["background", "foreground", "secondary", "muted", "muted-foreground", "border", "primary"]) {
    const value = next?.themeTokens?.[name];
    if (typeof value === "string") document.body.style.setProperty(`--${name}`, value);
    else document.body.style.removeProperty(`--${name}`);
  }
}

$("open-folder").addEventListener("click", () => void action("open-folder"));
$("close").addEventListener("click", () => void action("close"));
$("clear").addEventListener("click", () => void action("clear"));
document.addEventListener("click", (event) => {
  if (!event.target.closest(".row-menu, .row-actions")) document.querySelectorAll(".row-menu").forEach((menu) => { menu.hidden = true; });
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") void action("close"); });
api.onChanged(render);
api.onTheme(applyTheme);
void api.theme().then(applyTheme).catch(() => {});
void api.list().then(render).catch((error) => showNotice(error?.message || "Could not load downloads"));
