# Reconcile the late transport checkpoint

The integration owner is #3993, branch
`integration/plugin-byte-stream-handoff`. Its independently rechecked head
`6a4fb178cde73b57f78b1711a4e1f9a0f394b4fb` passed both
[test CI](https://github.com/binaricat/Netcatty/actions/runs/40365457418) and
[four-platform package CI](https://github.com/binaricat/Netcatty/actions/runs/40365457024).

The original transport owner later published #3988 at
`f1410f8bb172ef2c2069cc7d55a463f7cb127c0b`. Its common baseline with #3993 is
`c4433d4961ecf4a81bea92b0a14f47b4ec12f679`. The late commit has that baseline
and source checkpoint `4213d8e6726c44e7a479418ece3adf16ea494782` as parents.
The source checkpoint is already an ancestor of #3993.

## Keep the remaining transport changes

The late delta is not entirely superseded. An ordinary merge retains its
published history and these useful changes:

- Attach cleanup cancels a producer returned after runtime release exactly
  once. The new regression fails against the old #3993 service and passes
  with the late service change. The test uses a loopback fixture and a fake
  stream producer. It does not enumerate real interfaces.
- Service tests cover source replacement before permission publication and
  during a pending read. A router test checks one close notification for idle
  peer cancellation. The installed entrypoint also checks consumer cancellation.
- CLI and SDK tests cover the public canonical byte-stream requests. Shared
  manifest checks require the corresponding AI/context feature declarations.
  No AI runtime, broker, adapter, or renderer implementation is reviewed here.
- Database-specific testing moves out of `electron/plugins` into the minimal
  example. The opt-in test also installs its real package and checks the
  SDK/RPC path and audit omission. Its live pass at `f1410f8` remains historical
  evidence, not a new live pass on the current integration head.
- The example panel test checks password clearing and text-only result output.

## Resolve overlap in favor of the integrated behavior

| Overlap | Resolution |
| --- | --- |
| Marketplace source files and lockfile | Already identical to the late checkpoint |
| Own-machine address comparison | Retain #3993's IPv4 and mapped IPv6 normalization and regression |
| Cancelled buffered and in-flight credit | Retain #3993's stream lifecycle fix and regressions |
| Service test file | Combine the normalization test with all three late lifecycle/source tests |
| Installed entrypoint test | Keep retained-byte revocation coverage and add the late consumer-cancel case |
| Shared permission descriptions | Retain the newer connected AI checkpoint's descriptions |
| Assistant preparation | Retain the newer six-file staging build |
| Contract test | Retain the repaired optional-stream expectation and positive exact-resource assertion |
| Database preparation | Both sides minify the bundle. Keep the existing deterministic preparation |
| Native instructions | Keep the GUI's actual prerequisites. Its missing Docker and unsupported path to the coding container are not resolved by the late branch's local Docker recipe |

The original reports are retained in
[the historical acceptance record](byte-stream-acceptance.md). Neither their old
AI wiring status nor their environment-specific broad-test failures replace the
connected implementation and exact-head CI evidence on #3993. No main merge,
force-push, endpoint-policy relaxation, AI internal review retry, or release is
part of this reconciliation.

## Check the reconciled source

The merged transport source passed 627 registered runtime tests: 626 passed and
one native Electron test skipped. Contract/SDK/CLI tests passed 90 of 90. The
example panel passed; its opt-in database test remained skipped. The late attach
regression failed against the old #3993 service with two cancel calls instead
of one, then passed after the merge.

A subsequent example-only Rfam candidate reuses the limited browser protocol
through two fixed entrypoints. Its offline tests check the original owned
fixture database/query and the fixed public database/query, plus rejection of
an unsupported auth plugin. No general query API is exported and no host
database code is introduced. The owned MariaDB live regression remains opt-in.
