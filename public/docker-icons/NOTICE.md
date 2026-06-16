# Docker brand icons

Files in this directory are static SVG assets for the Docker container / image
manager UI. They are generated once via `node scripts/sync-docker-icons.mjs` and
committed to the repository (not downloaded during build or pack).

## Source

Icons are derived from [Simple Icons](https://simpleicons.org/) (CC0 1.0).
Each file is a monochrome SVG recolored for contrast on the brand tile background
defined in `domain/systemManager/dockerImageIcons.ts`.

### Additional official sources (not in Simple Icons)

| Icon id | Source |
| --- | --- |
| `nacos` | [nacos-group/nacos-logo](https://github.com/nacos-group/nacos-logo) (`Nacos logo 白蓝资源 5.svg`) |
| `polaris` | [polarismesh/polaris](https://github.com/polarismesh/polaris) (`logo.svg`) |
| `memcached` | [memcached.org](https://memcached.org/images/memcached_link_125.png) — official PNG only (maintainers publish no SVG) |

Other brands without any official asset fall back to the bundled Docker logo.

Brand logos remain the property of their respective owners.
