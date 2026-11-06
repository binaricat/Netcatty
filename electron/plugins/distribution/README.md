# Pinned static distribution schemas

`delivery.schema.json` and `index.schema.json` are unmodified UTF-8 files from
binaricat/netcatty-plugins commit 7bfe23e5627e16ba63806de6dded5b2667c02984
(PR 3). The host compiles them with the existing local plugin-contract schema;
no schema reference causes network access.

`../fixtures/static-distribution/` contains that commit's actual
`distribution/bootstrap/v1/snapshot.json`, snapshot catalog/index/delivery and
four referenced README/PNG assets. Raw-byte SHA-256 checks in
`staticDistribution.test.cjs` verify the publisher's supplied pointer and delivery
hashes; every document and asset is checked against the pointer/sidecar.
The fixture includes no executable plugin package, avatar or credentials.

Schema revisions must be coordinated with the registry publisher. In particular,
artifact/avatar are deliberately null in v1; do not expand this consumer alone.

`delivery-v2.schema.json` is vendored without changes from
`binaricat/netcatty-plugins@2ffed31ad6a430e3711a63a902305063bd2504f8`,
`schema/delivery-v2.schema.json` (Git blob
`7a57504fbea272ca0e873725e050d1f15352cb5b`). The v2 consumer retains the pinned v1
schema and permits positive-size package references up to 16MiB and PNG/WebP avatar references.
Avatar references require positive size up to 256KiB and exact content-addressed
paths. No v3 path is added. The original bootstrap bytes remain unchanged, and
client support does not publish or activate live metadata.
