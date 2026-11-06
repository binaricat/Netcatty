# Selected-context authority reference

`electron/plugins/context/selectedContextAuthority.cjs` implements text disclosure.
It does not issue typed Host targets or authorize edit, connect, or command actions.

The constructor is `new SelectedContextAuthority({ resolveDataOwner, clock?,
limits? })`. `resolveDataOwner(context)` returns the authenticated host-owned source
binding. Runtime identity comes from the host RPC context, never plugin arguments.

| Method | Meaning |
| --- | --- |
| `share({scope,title,version,readText,isCurrent}, context)` | Trusted host issues an opaque, expiring text handle. Returns a summary. |
| `summaries(context)` | Enumerates only this source/runtime's shared summaries. Does not call `readText`. |
| `read({handle,version}, context)` | Checks identity, expected version, current owner, lifetime, and resource currency before and after the bounded read. |
| `assertCurrent({handle,version}, context)` | Checks currency without reading content. |
| `onDidInvalidate(listener)` | Observes handle revocation. One failed listener cannot interrupt cleanup. |
| `release(handle)` | Revokes one text handle. |
| `releaseRuntime(runtimeId)` | Revokes that runtime's text handles. |
| `releaseOwner(owner)` | Revokes that exact owner binding's text handles. |
| `shutdown()` | Revokes all handles. |

The summary contains `handle`, `scope`, `title`, `version`, and `expiresAt`.
`scope: "host"` means curated host-related text. It is not a Host entity reference.
A summary, menu ID, title, or host-related text cannot become an action target.

`PluginAISourceBinding` in `electron/plugins/ai/sourceBinding.cjs` consumes the
market owner's source API. `resolve(context)` first authenticates the current
browser runtime and then returns a stable frozen object containing `runtimeId`,
`pluginId`, `pluginVersion`, `sourceKey`, and `privateOwner`. It revalidates source
binding after asynchronous authentication. The object never crosses plugin RPC.
`sourceKey` binds the source ID, kind, and origin. It is not a trust endorsement.
This helper supplies neither resource selection nor action authorization.

Resource currency remains a trusted `isCurrent()` callback. The callback binds
the selected resource, expected revision, current host window, and its lifecycle.
The authority stores the issued version separately and never accepts a later
plugin-supplied revision as authoritative.

The Host/Vault action task requires a separate typed selection authority. Such a
target binds the host-owned source identity, runtime, plugin version, window owner
and generation, exact Host ID, expected Host revision, expiry, and allowed action.
Each action needs its own grant and host confirmation. Text-read handles must not
implicitly gain edit or connect authority. Host draft review and connection
confirmation remain separate workflows owned by that task.
