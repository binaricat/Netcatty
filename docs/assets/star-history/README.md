# Star History Charts

Static SVG charts committed to the repo so README embeds keep working without
depending on `api.star-history.com` (which broke after GitHub restricted the
public stargazers API in 2026).

- `star-history-light.svg` — light theme
- `star-history-dark.svg` — dark theme

## Regenerate locally

Requires Python 3.6+, [gh CLI](https://cli.github.com/) authenticated as a
repo admin/collaborator (stargazers list is no longer public).

```bash
# From repo root
tmpdir=$(mktemp -d)
git clone --depth 1 https://github.com/carsteneu/mystarhistory.git "$tmpdir/mystarhistory"
python3 "$tmpdir/mystarhistory/mystarhistory.py" \
  --repo binaricat/Netcatty \
  --output docs/assets/star-history/star-history-light.svg
python3 "$tmpdir/mystarhistory/mystarhistory.py" \
  --repo binaricat/Netcatty \
  --dark \
  --output docs/assets/star-history/star-history-dark.svg
```

Or trigger the **Star History** GitHub Actions workflow
(`.github/workflows/star-history.yml`). It reuses the existing `RELEASE_TOKEN`
secret (same PAT already used for release publishing) so no new secret is
needed. Because `main` requires pull requests (with admin enforcement), the
workflow never pushes to the default branch directly: it force-updates
`chore/star-history` with `RELEASE_TOKEN`, then opens/reuses and squash-merges
a PR with the built-in `GITHUB_TOKEN` (PATs often lack `createPullRequest`).
`RELEASE_TOKEN` must be able to:

- read stargazers (repo admin/collaborator)
- push the `chore/star-history` branch

Also ensure the repo setting **Allow GitHub Actions to create and approve pull
requests** is enabled so `GITHUB_TOKEN` can open the chart PR.
