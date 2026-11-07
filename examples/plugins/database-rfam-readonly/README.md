# Prepare the public Rfam read-only acceptance sample

This is a public third-party acceptance candidate, separate from the owned
MariaDB fixture. It uses the existing generic byte-stream capability. No host
database business, server-specific production API, or endpoint-policy exception
is added.

[Rfam's official database documentation](https://docs.rfam.org/en/latest/database.html)
lists `mysql-rfam-public.ebi.ac.uk:4497`, database `Rfam`, public user `rfamro`,
and no password. The sample sends only `SELECT 1 AS value`. It does not read Rfam
tables and offers no query, host, database, or credential input. The documented
public account name is compiled into the example. No private credential is used
or persisted, and the sample has no storage or secret permission.

## Build the candidate without connecting

Use the integration head and locked dependencies:

```sh
npm run build:plugin-runtime-deps
node examples/plugins/database-rfam-readonly/prepare.mjs tcp://mysql-rfam-public.ebi.ac.uk:4497 /tmp/database-rfam-readonly.ncpkg
node packages/plugin-cli/dist/cli.js validate /tmp/database-rfam-readonly.ncpkg
sha256sum /tmp/database-rfam-readonly.ncpkg
```

The separate preparation command accepts only that exact endpoint. It performs
no DNS lookup, connection, query, plugin installation, or permission activation.
It creates five files: a manifest, browser bundle, and three panel assets.
The owned fixture's preparation command still rejects public hostnames.

Package identity and permission scope:

- ID: `com.netcatty.database-rfam-readonly`, version `0.1.0`.
- Runtime: browser only. Required feature: `network.byte-streams`.
- Required permissions: `commands` and `views` for its own callbacks and panel.
- Optional permission: `network.stream`, resource exactly
  `tcp://mysql-rfam-public.ebi.ac.uk:4497`.
- Five-file package: 11,003 bytes. Two builds matched byte for byte with SHA-256
  `aaca586669db454e91d61487e576ed524d1b7190eed182bc2cd0035e59caa0d3`.
  This is the dedicated acceptance candidate's package, rebuilt with its SDK.
  The earlier #3993 archive had a different hash; do not reuse an earlier
  artifact's authorization for this package.
- Expected result after a separately authorized compatible run:
  `{"columns":["value"],"rows":[["1"]]}`.

## Obtain authorization before native acceptance

Record the exact integration commit, package hash, ID, version, and permissions.
The parent must obtain authorization for that specific package and public
endpoint before installation, enabling permissions, or querying the service.
No connection or query has been performed as part of preparing this candidate.

After authorization, use the available native desktop and a disposable profile.
Record the local-import source, exact endpoint prompt, denial, retry, fixed
result, cancellation, and post-revocation recovery. Opening the panel only reads
its endpoint metadata. A connection starts only from **Run fixed public query**.
Do not treat this public service as an isolated synthetic fixture or evidence of
database TLS or native sandbox certification.

## Stop if the protocol is unsupported

The reused example protocol supports only protocol 4.1 and
`mysql_native_password`. It uses plain TCP and does not implement MySQL STARTTLS,
auth-plugin switching, or other authentication methods. The service's current
authentication and TLS requirements remain unverified. An unsupported greeting
or server rejection fails closed and closes the byte stream. Record a sanitized
failure and stop. Do not add an authentication fallback or TLS bypass for QA.

Offline protocol tests inspect synthetic packet bytes for the two fixed
profiles and reject an unsupported auth plugin. They do not contact Rfam or
activate plugin permissions:

```sh
npm run test:plugin-examples
```

The owned MariaDB regression remains at
`examples/plugins/database-minimal/protocol.live.test.cjs`. Its explicit Docker
opt-in, isolated network, temporary account, SELECT result, and server-side write
denial remain separate from this public-service candidate.
