"use strict";

// In-process terminal backends share one registry. Remember the first renderer
// for each session object, not its mutable output route: an attached popup is
// only a display, and a replacement boot is a different object.
const owners = new WeakMap();
const trackedRegistries = new WeakMap();

function resolveLifetimeHeir(sessionId, contents) {
  const heirId = require("./terminalAttachRestore.cjs").getLifetimeHeirWebContentsId(sessionId);
  if (typeof heirId !== "number" || heirId === contents?.id) return null;
  try {
    const heir = require("electron").webContents?.fromId?.(heirId);
    return heir && !heir.isDestroyed?.() ? heir : null;
  } catch {
    return null;
  }
}

function trackRendererSessionLifetime(sessions, sessionId, contents, closeSession, transferOwnership = false) {
  const session = sessions?.get(sessionId);
  // Worker/agent senders are synthetic and have no renderer destruction event.
  if (!session || typeof contents?.once !== "function") return;
  if (owners.has(session) && !transferOwnership) return;
  owners.set(session, contents);
  let tracked = trackedRegistries.get(sessions);
  if (!tracked) trackedRegistries.set(sessions, tracked = new WeakSet());
  const closeOwnedSessions = () => {
    for (const [id, current] of [...sessions]) {
      if (owners.get(current) !== contents || sessions.get(id) !== current) continue;
      // A tab moved into its own window outlives the window it came from.
      const heir = resolveLifetimeHeir(id, contents);
      if (heir) {
        trackRendererSessionLifetime(sessions, id, heir, closeSession, true);
        continue;
      }
      closeSession({ sender: contents }, { sessionId: id, bootEpoch: current.bootEpoch });
    }
  };
  if (!tracked.has(contents)) {
    tracked.add(contents);
    contents.once("destroyed", closeOwnedSessions);
  }
  // An asynchronous start may finish after its window disappeared. Let its
  // synchronous setup finish (including acquiring SSH leases), then close only
  // the still-owned object through the same path as an explicit tab close.
  if (contents.isDestroyed?.()) queueMicrotask(closeOwnedSessions);
}

module.exports = { trackRendererSessionLifetime };
