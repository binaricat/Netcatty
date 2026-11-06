# Byte stream integration checkpoint

The original transport checkpoint is #3988
`c4433d4961ecf4a81bea92b0a14f47b4ec12f679`. The separate integration branch
`integration/plugin-byte-stream-handoff` preserves that history and ordinarily
merges source identity #3981 `4213d8e6726c44e7a479418ece3adf16ea494782`
and connected AI #3986 `173ef5abbb1f8cea4e2c409c5791186926b778e1`.
The original transport branch remains untouched. Follow the
[current native handoff](byte-stream-native-qa.md) for the integrated package.
The late transport checkpoint `f1410f8` is subsequently preserved through an
ordinary merge. [The comparison record](late-transport-integration.md) lists its
remaining changes and the conflict resolutions that preserve the two P2 fixes
and newer connected AI files.

## Registered transport

Canonical definitions are in `packages/plugin-contract/schema/plugin-contract.schema.json`.
`network.byte-streams` negotiates the capability. The separate `network.stream`
permission requires explicit `tcp://host:port` or `tls://host:port` resources.
Wildcard declarations and grants cannot authorize raw streams. HTTP grants and
payload limits are unchanged.

The SDK exposes `context.network.connect({ endpoint }, cancellationToken?)`.
The returned connection has `endpoint`, `readable`, `writable`, `close()`, and
`dispose()`. The control methods are `network.stream.connect`,
`network.stream.attach`, and `network.stream.close`. Descriptors, request
shapes, feature names, limits, generated SDK types, and host validators share
the canonical schema. Unknown request properties are rejected.

The registered service authenticates the host runtime before source lookup.
Runtime startup captures the existing opaque source owner. Every asynchronous
commit revalidates the runtime, active and retained source, and opaque owner
through the source task's APIs. Caller-supplied owner/source parameters are
rejected. Audit commits also verify the source binding.

Connection and stream IDs are host-issued and bound to that runtime and owner.
The SDK prepares its incoming waiter before attach starts the host producer.
Both directions reuse the existing binary stream router and credit windows.
Input credit returns after the socket write callback. Output backpressure
bounds the producer. The router has one optional producer `onClose` hook;
peer cancellation releases the socket even while it is idle.

The host validates all DNS answers and pins a literal IP. Production rejects
loopback, link-local, unspecified, multicast, mapped local addresses, selected
IPv6 tunnel forms, and the machine's own interface addresses. The production
host constructor never forwards the core's explicit local-test override.
There is no proxy discovery, reconnect, UDP, listen, generic IPC, shell, Node
plugin runtime, or filesystem escape.

Limits are four connections per runtime, 64 globally, 64 KiB chunks and socket
buffer thresholds, and 8 MiB combined bytes per connection, plus the existing
runtime byte quota. Connect, idle, and lifetime deadlines are 10, 30, and 120
seconds. Close tombstones are capped at 256 small identity records. Revocation,
runtime stop, disable, shutdown, and stream cancellation release resources.

TLS requires trust and original-hostname validation with TLS 1.2 or later.
Plugins cannot set custom CAs, SNI, or validation exceptions. STARTTLS is not
implemented. Generic audit records contain endpoint, runtime, handle, and byte
counts. The host does not inspect SQL or record payloads or credentials.

## Integrated AI interface

The same canonical schema defines the relayed `AI_CONTEXT_ROUTES` types.
The SDK/runtime expose `context.ai.openChat/startTurn/readTurn/stopTurn/closeChat`
and `context.selectedContext.list/read`. Host registration advertises
`ai.model-invocation` and `context.selected-read`, and wires runtime cleanup,
plugin disable, revocation through the service, and shutdown.

The connected host renderer and shared permission descriptions from #3986 are
preserved. Its owner documents the adapter and existing configured model path in
[the AI checkpoint](ai-context-wip.md), with a
[synthetic native assistant recipe](assistant-native-qa.md). The original AI
worker later reconsidered the earlier review restriction once with newer
maintainer evidence and completed the review. Published fixes and remaining
verification/native holds are tracked in the current
[acceptance matrix](acceptance-candidate.md). This integration task does not
repeat that review.

## Database example

`examples/plugins/database-minimal` is an ordinary browser plugin. Its developer
preparation tool creates an `.ncpkg` for one exact disposable private IPv4
endpoint. The output contains a browser bundle, a normal manifest, and view
assets. The preparation tool and its Node dependencies are not in the plugin.

Only the example contains the database protocol: common protocol 4.1,
`mysql_native_password`, and
`SELECT value FROM plugin_demo.example_result LIMIT 1`.
The view accepts session-only fixture credentials and clears its password
field before dispatch. It does not save view state, settings, logs, or secrets.
The host never exposes SSH or AI credentials. JavaScript does not promise
memory zeroization. The account's server-side SELECT grant enforces read-only
access. The fixed query is not a SQL security classifier.

The example has no query editor, schema browser, pool, arbitrary SQL, or host
connection-management subsystem. See the example README for native setup.

## Evidence and limits

- Both source-reviewed races have executable real-loopback regressions here.
  Delayed final-byte consumption previously lost EOF after the socket closed.
  Double-microtask cancellation previously created an untracked late socket.
  Each regression failed before its respective fix and passed afterward.
- The broker tests use real TCP/TLS sockets, including trusted fixture CA,
  untrusted certificate and wrong-hostname denial. Connect and idle deadline
  cases use mock clocks around real sockets or delayed DNS.
- The installed entrypoint test builds and installs a normal package, executes
  its actual browser entry module through SDK/RPC/binary streams, and exercises
  grant denial, exact resources, unknown-field rejection, close, revoke, and
  disable. It also exercises registered AI/context SDK routes with a synthetic
  trusted adapter. Its runtime harness is Node and is explicitly not a browser
  sandbox or OS sandbox test.
- The disposable MariaDB test checks a synthetic SELECT result and server-side
  INSERT denial. It creates an internal network, publishes no host ports, and
  removes the container and network. Database transport is plain TCP inside
  that disposable network, not database TLS.

The integration fixes own-machine comparison across IPv4 and mapped IPv6.
Its regression mocks interface lookup and uses a fake dialer. It does not retry
the reviewer's failed EPERM interface lookup. Other private peers remain allowed.

Cancellation now discards buffered browser bytes, settles producer-cancelled
credit once, and retains terminal producer state only until outstanding credit
arrives. Existing sequence, schema, and negotiated-window checks still reject
unknown, duplicate, out-of-order, and excess credit. Incoming cleanup runs even
if a cancellation refund cannot be sent. This uses the existing stream lifecycle
and runtime shutdown, without another scheduler.

Normal native BrowserWindow and screenshot/video acceptance remain pending.
The native GUI machine lacks Docker and is occupied with SSH acceptance. See
the handoff for fixture prerequisites. Do not disable the Chromium sandbox or
relax endpoint restrictions to obtain that evidence.
