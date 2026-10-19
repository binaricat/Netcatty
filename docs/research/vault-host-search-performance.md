# Vault host search performance

Issue #3720 covers a large-library input stall already present in v1.1.83. It is separate from the snippet argument-completion repair in #3717. The recent IP sort is not the cause: A–Z sorting reproduces the same delay.

## Cause and scope

`getHostSearchMatch` evaluates matching/ranking against host label, group, tags and hostname. After literal and compact comparisons fail, human fields may also use pinyin. Printable ASCII fields cannot gain another match from that fallback, but repeated queries still performed its conversion/cache operations for thousands of hosts.

The repair only skips that redundant host-field fallback. Literal and compact matching remain ahead of it; source preference, phases, scores, Chinese/mixed-language matching, IP isolation, usernames/notes fallback, sorting and rendered fields are unchanged. The generic search and snippet matchers are not modified.

## Reproduction and verification

```sh
node_modules/.bin/electron scripts/vault-host-search-performance.live.test.cjs
```

The isolated Electron fixture renders production `useVaultHostCollections` and `VirtualizedHostCollection` with 5,000 synthetic hosts across 100 groups. It changes the actual controlled input through React `onChange`, repeats 63 input events over three rounds, measures render/input-task delay and compares result counts/order fingerprints. Only 15 host rows are mounted. It does not access user hosts, SSH servers or settings.

The real input regression was observed failing before the source change: warmed `Region 99` events delayed the next input turn by 100.2 and 89.6 ms. After the repair they took 24.2 and 23.2 ms. The standalone measurement uses a 50 ms warmed-input gate; slower test machines can set `NETCATTY_VAULT_SEARCH_MAX_INPUT_MS` explicitly. It is skipped under ordinary Node tests, where real renderer timings are unavailable.

| Query | Before render task | After render task | Matches |
| --- | --- | --- | --- |
| `production web` | 59.4–62.8 ms | 17.8–21.2 ms | 5,000 |
| `Region 99` | 89.1–99.5 ms | 20.2–23.6 ms | 95 |
| `no-match-query` | 36.4–90.4 ms | 13.8–17.1 ms | 0 |

All 63 before/after input events retained the same result count and complete-order fingerprint. `Region 99` returning 95 hosts is existing multi-segment matching behavior; this repair does not reinterpret it as a group-only filter.

Separate four-round diagnosis compared current source, v1.1.83 source and A–Z/IP sorting. Release source reproduced 56.4–59.2 ms for `production web` and 90.5–101.4 ms for `Region 99`, confirming an existing bottleneck rather than a newly introduced regression. These are representative local renderer measurements, not a guarantee for every host library or device.

Semantic tests cover ASCII separator compaction and punctuation, fullwidth normalization, direct IP matches and cross-field isolation, strict source preference, Chinese/mixed-language pinyin, and complete matching phase/method/score details. They also pass against the original implementation.
