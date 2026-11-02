#!/usr/bin/env bash
# Points every download in a release's latest.json at github.com/<repo>/releases/download/<tag>/<file>.
# tauri-action writes the links of the draft (api.github.com/.../releases/assets/<id> or
# .../download/untagged-.../<file>), and the updater cannot download those once the release is published.
#   origami-fix-latest-json.sh <owner/repo> <tag> <latest.json in> <latest.json out>
set -euo pipefail

repo=$1 tag=$2 in=$3 out=$4

# The release is still a draft, so it is found by tag among all releases, not by /releases/tags/<tag>.
assets=$(gh api "repos/$repo/releases" --paginate \
  --jq "[.[] | select(.tag_name == \"$tag\") | .assets[] | {key: (.id | tostring), value: .name}] | from_entries")

jq --arg base "https://github.com/$repo/releases/download/$tag/" --argjson assets "$assets" '
  .platforms |= map_values(.url |= (
    (capture("/releases/assets/(?<id>[0-9]+)$").id // null) as $id
    | if $id then
        ($assets[$id] // error("no asset with id \($id) in the release"))
      else
        split("/") | last
      end
    | $base + .
  ))
' "$in" > "$out"

jq -r '.platforms | to_entries[] | "\(.key) \(.value.url)"' "$out"
