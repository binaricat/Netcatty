#!/usr/bin/env bash

set -euo pipefail

input_path="${1:?input path is required}"
research_dir="${2:?research directory is required}"
attachment_urls_path="$research_dir/attachment-urls.json"

node -e '
  const fs = require("node:fs");
  const auto = require(process.env.RUNNER_TEMP + "/cursor-automation.cjs");
  const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const urls = auto.extractGithubUserAttachmentAssetUrls(input);
  fs.writeFileSync(process.argv[2], JSON.stringify(urls) + "\n");
' "$input_path" "$attachment_urls_path"

attachment_count="$(node -p 'require(process.argv[1]).length' "$attachment_urls_path")"
if (( attachment_count > 4 )); then
  echo "Too many GitHub image attachments for bounded research: ${attachment_count}" >&2
  exit 1
fi
if (( attachment_count == 0 )); then
  cp "$input_path" "$research_dir/input.json"
  exit 0
fi

mkdir -p "$research_dir/attachments"
container_name="cursor-research-imgproxy-${GITHUB_RUN_ID}-${GITHUB_JOB}"
docker run -d --rm --name "$container_name" \
  --cap-drop=ALL --security-opt=no-new-privileges --read-only \
  --memory=512m --cpus=1 --pids-limit=128 \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  -p 127.0.0.1:18081:8080 \
  -e IMGPROXY_ALLOWED_SOURCES=https://github.com/user-attachments/assets/ \
  -e IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES=false \
  -e IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES=false \
  -e IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES=false \
  -e IMGPROXY_MAX_SRC_FILE_SIZE=10485760 \
  -e IMGPROXY_MAX_SRC_RESOLUTION=50 \
  -e IMGPROXY_MAX_RESULT_DIMENSION=4096 \
  -e IMGPROXY_MAX_REDIRECTS=2 \
  -e IMGPROXY_MAX_ANIMATION_FRAMES=1 \
  -e IMGPROXY_ALWAYS_RASTERIZE_SVG=true \
  -e IMGPROXY_ALLOW_SECURITY_OPTIONS=false \
  -e IMGPROXY_COOKIE_PASSTHROUGH=false \
  -e IMGPROXY_COOKIE_PASSTHROUGH_ALL=false \
  "$CURSOR_RESEARCH_IMGPROXY_IMAGE" >/dev/null
stop_imgproxy() {
  docker stop "$container_name" >/dev/null 2>&1 || true
}
trap stop_imgproxy EXIT

for (( index=0; index<attachment_count; index++ )); do
  source_url="$(node -e '
    process.stdout.write(require(process.argv[1])[Number(process.argv[2])]);
  ' "$attachment_urls_path" "$index")"
  encoded_source="$(node -e '
    process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"));
  ' "$source_url")"
  output_path="$research_dir/attachments/issue-image-$((index + 1)).png"
  curl --retry 8 --retry-all-errors --retry-delay 1 --retry-max-time 45 \
    --connect-timeout 3 --max-time 30 -fsS \
    "http://127.0.0.1:18081/unsafe/${encoded_source}.png" \
    -o "$output_path"
  node -e '
    const fs = require("node:fs");
    const expected = Buffer.from("89504e470d0a1a0a", "hex");
    const actual = fs.readFileSync(process.argv[1]).subarray(0, expected.length);
    if (!actual.equals(expected)) throw new Error("imgproxy did not produce PNG output");
  ' "$output_path"
done

stop_imgproxy
trap - EXIT
# The single-quoted program intentionally contains JavaScript template syntax.
# shellcheck disable=SC2016
node -e '
  const fs = require("node:fs");
  const auto = require(process.env.RUNNER_TEMP + "/cursor-automation.cjs");
  const input = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const urls = require(process.argv[2]);
  const attachments = urls.map((sourceUrl, index) => ({
    sourceUrl,
    relativePath: `attachments/issue-image-${index + 1}.png`,
  }));
  fs.writeFileSync(
    process.argv[3],
    JSON.stringify(auto.rewriteExternalResearchInputAttachments(input, attachments), null, 2) + "\n",
  );
' "$input_path" "$attachment_urls_path" "$research_dir/input.json"
