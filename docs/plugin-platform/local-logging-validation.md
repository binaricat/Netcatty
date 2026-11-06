# Local logging validation

Base: PR #3978 at `91b8927c56314e68c06e2c008e84559ddfb96d78`.
All data used in these checks is synthetic and each persistence test creates its
own temporary profile. No real logs or credentials were opened.

| Check | Result |
| --- | --- |
| `node --test electron/plugins/*.test.cjs` | 561 passed, 2 expected skips (Electron live test and the #3981 database integration test on this older base) |
| New logging settings, existing settings and permission-panel interaction tests | 4 passed |
| `npm run build` | Passed; existing large-chunk warning |
| `npm run lint` | No errors, 7 existing warnings; final changed-source lint also passed |
| `npm run check:plugin-contract` | Passed, no generated drift |
| `npx tsc --noEmit` against this change and the exact base | 773 diagnostics in each, zero added or removed after normalizing worktree paths |
| `git diff --check` | Passed |

Coverage includes disabled and enabled persistence, opt-in plugin text, sensitive
field exclusion, host source attribution, unknown-source fallback, URL rejection,
spoofed metadata, cyclic/accessor/proxy input, noisy writers, shared queue and disk
limits, rotation, expiration, drop/error counts, export, clear confirmation,
disable/revoke, stale runtime callbacks, and manager shutdown. The filesystem
regressions cover direct paths, symlink aliases, a symlinked profile directory,
and revocation during the final protected-storage check.

## Remaining native checks

Electron launch failed before application/profile startup. The executable at
`node_modules/electron/dist/electron --version` aborted with:

> The SUID sandbox helper binary was found, but is not configured correctly.

Its message requires `chrome-sandbox` to be root-owned with mode 4755. No sandbox
switch, privilege escalation, permission repair, or native retry followed. Native
smoke execution, screenshots, and a short recording remain pending. The acceptance
flow is in [Local plugin logging](local-logging.md#native-qa-with-synthetic-data).

`npm run pack:dir` completed its production build, then failed during serialport
native rebuilding: node-gyp returned ENOENT for mkdir
`/home/agent/.electron-gyp`. No system-directory change or packaging retry followed.
A native package was not produced.

## Parent integration

The only shared settings-page change is one import and one `<PluginLogSettings />`
element. Preserve that element when integrating the marketplace task's page.
There are no Installed, Official, Third-party, source-database, or unrelated host
data changes.

The default host-owned resolver is wired through `createPluginHostService`. It
consumes #3981's confirmed API without editing its database or sync implementation.
On the older #3987 base, missing source APIs remain explicitly unknown. No shared
transport-registration change is needed beyond the existing logging registration.

## Source and review follow-up

A separate worktree at `59721f97172acffffe960a6268a2916a90a6c554` received only
the logging backend overlay. Its logging/source/host regression command passed
33 tests with no skips, including the real database replacement, encoded local-owner roundtrip and
shutdown-drain case. The product branch does not import marketplace changes or bump its database
schema.

Independent review of the implementation follow-up found no remaining blocking
findings. Independent runs passed 50 focused regressions with one expected source
skip, 20 real-source integration regressions with no skips, and the logging UI
interaction test. The reviewer made no edits and did not launch Electron. A further independent
review of the newer encoded-local-owner contract found no issues; all six
provenance tests passed on exact `59721f97172acffffe960a6268a2916a90a6c554`,
with an additional probe confirming the local encoded owner.

Fixed review findings have deterministic regressions: 31 days of low-volume
appends and export cannot extend segment retention via mtime; stale sources cannot
rotate away existing evidence; settings-write failure shows actual host state;
log draining still completes when another shutdown stage rejects; and activation
permission denial produces a fixed host record before runtime creation.

Exact prior head `e3cc23bca81a4187ccc13b90d3882889d524ca3b` passed remote
[test 40339839263](https://github.com/binaricat/Netcatty/actions/runs/40339839263)
and [build-packages 40339839660](https://github.com/binaricat/Netcatty/actions/runs/40339839660).
Those runs do not validate the follow-up head. Its exact-head CI is reported in
the PR after pushing.

The native fixture build is reproducible: 3,270 bytes, SHA-256
`c3770a55676ed708f01ec1e0e0b9968ffb5e03c02303ee7cb9f739bde27c9de0`.
The concise flow and commands are in [Local plugin logging](local-logging.md#native-qa-with-synthetic-data).
Native screenshots and recording remain assigned to the parent's working cloud
GUI machine. No local sandbox bypass or packaging retry is authorized by this
handoff.
