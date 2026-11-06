# Byte stream acceptance evidence

This is the historical report published by the transport owner at #3988
`f1410f8bb172ef2c2069cc7d55a463f7cb127c0b`. Its local failures, package hash,
and missing AI wiring describe that branch and environment. The current owner
is #3993 on `integration/plugin-byte-stream-handoff`. Follow
[the integration handoff](byte-stream-native-qa.md) for current checks, the
connected AI checkpoint, and native prerequisites. The old GUI-local Docker
recipe is not applicable to the occupied GUI machine without Docker.

The integration retains #3978 `91b8927c56314e68c06e2c008e84559ddfb96d78`,
source fixes through #3981 `4213d8e6726c44e7a479418ece3adf16ea494782`, and
AI service checkpoint #3986 `264f1d983cd1ed83fe4873974a614fff2f47f989`.
The transport delta does not edit the source database or sync implementation.
Draft PR #3988 records the published review head. No merge or release is authorized.

## Completed local checks

The delegated environment uses Node 24.19.0 on Linux.

- `npm run test:plugin-contract`: 90 passed, zero skipped.
- `npm run test:plugin-runtime`: 604 passed, one native Electron test skipped.
  Database-specific testing is now entirely in the example directory.
- Final focused transport, source-isolation, installed entrypoint and disposable
  database run before the test-file move: 32 passed, zero skipped. After the
  move, the same installed database test passed again at its example path.
- `NETCATTY_BYTE_STREAM_DATABASE_TEST=1 node --test examples/plugins/database-minimal/protocol.live.test.cjs`:
  real MariaDB result and server-side INSERT denial passed through both the
  core and the ordinary installed example entrypoint. No host ports, fixture
  override, real hosts, or real credentials were used by this database test.
  Its container, network, package and profile were removed.
- `node --test examples/plugins/database-minimal/panel.test.cjs`: password
  clearing before dispatch and safe text rendering passed.
- Production `npm run build`, generated contract drift, changed-source lint,
  and whitespace checks passed.

Real broker TLS tests validate trust and the original requested hostname using
a disposable fixture CA. Database traffic is plain TCP inside an internal
Docker network. Neither check proves native BrowserWindow sandbox behavior,
database TLS, device testing, or real model inference. The registered AI/context
entrypoint test uses a synthetic trusted adapter, not the outstanding renderer
wiring owned by the AI task.

The EOF and last-await cancellation regressions each failed before their fix
and passed after it with real loopback sockets. Source changes before grant
publication, source changes during a pending read, and a stream returned after
runtime release have separate passing regressions.

## Reproducible native sample

Run the preparation tool for `tcp://172.30.247.2:3306` as described in
[`examples/plugins/database-minimal/README.md`](../../examples/plugins/database-minimal/README.md).
Two separate staging directories produced the same five-file package:

- Archive bytes: 11,621.
- SHA256: `53b1aebae27d0681d0e93b8f7529f574cc2f176f3ca34eb2eabd1c35cdfb3deb`.
- Content SHA256: `c83c6913f4ea40eae80d7042231b083be7d35b27022d6df24de9ce09022f0016`.
- Delegated artifact: `/workspace/artifacts/plugin-byte-stream/database-minimal.ncpkg`.

The artifact contains no credentials or server setup. Changing its approved
fixture endpoint requires a newly prepared package and a recorded new hash.

## Checks that did not pass locally

`npm run pack:dir` first failed in the existing Cursor SDK preparation step
because npm could not create `/home/agent/.npm/_cacache`. Retrying with npm and
Electron build caches under `/workspace` passed that step, then failed while
rebuilding `@serialport/bindings-cpp`: `@electron/rebuild` hard-codes the
unwritable `/home/agent/.electron-gyp` directory. The native rebuild was not
disabled, HOME was not changed, and no sandbox setting was weakened. Full app
directory packaging remains failed locally and needs the normal CI or native
QA build environment.

The broad `npm test` run reported failures in existing transfer-resume,
Markdown editor, SSH algorithm, SDK/CLI platform, terminal paste, and updater
tests, then stalled without a final aggregate. Its owned process tree was
terminated. It is not reported as a passing full test run.

An independent source-baseline worktree at `4213d8e` ran five affected files in
the same environment with shared dependencies: 145 tests, 118 passed,
24 failed, three skipped. It reproduced failures in transfer-resume,
Markdown editor, SSH algorithms, AI bridge resolution, and updater tests;
updater errors include the unavailable `/home/agent/.netcatty/tmp/Netcatty`.
This diagnoses that tested subset only. It does not classify every broad-suite
failure, replace exact-head CI, or make any failed result successful.

## Pending acceptance

Exact published-head CI and independent review remain pending. The parent owns
sequential native GUI acceptance for streams and the database example, then AI,
then logging integration. The native recipe covers ordinary install/source and
endpoint review, deny/retry/query, cancel/revoke/disable, restart with no saved
password, audit inspection, screenshots, and a short recording. No native GUI
run or screenshot/video result is claimed by this delegated executor.
