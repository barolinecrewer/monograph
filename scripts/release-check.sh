#!/bin/sh
# Release check: build a release and make sure nothing personal is in it.
#
#   scripts/release-check.sh            exit 0 clean, 1 something found, 2 could not check
#
# Builds from a copy of the sources (this checkout's dist/ is left alone,
# config.local.json is not copied), then searches the built plugin and the
# skin for:
#   - the login name, the home folder, any /Users/<name> or /home/<name> path
#   - this repo's git user.name and user.email
#   - every personal value in config.local.json (name, avatar, greeting, the
#     labels and ids of pinned items, knowledge sources) and any of its add-ons
#   - anything shaped like a Hermes session id
# Nothing personal is written into this script: it reads the values at run time.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)

command -v node > /dev/null 2>&1 || {
  echo "release-check: node is not installed" >&2
  exit 2
}

stage=$(mktemp -d "${TMPDIR:-/tmp}/monograph-release.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 130' INT TERM

cp -R "$repo/build.mjs" "$repo/package.json" "$repo/src" "$repo/skin" "$stage/"

if ! out=$(cd "$stage" && HERMES_HOME="$stage/no-install" node build.mjs --release 2>&1); then
  printf '%s\n' "$out" >&2
  echo "release-check: the release build failed" >&2
  exit 2
fi

printf '%s\n' "$out" | head -1

MG_REPO="$repo" MG_STAGE="$stage" MG_USER="$(id -un)" \
  MG_GIT_NAME="$(git -C "$repo" config user.name 2> /dev/null || true)" \
  MG_GIT_EMAIL="$(git -C "$repo" config user.email 2> /dev/null || true)" \
  node --input-type=module - << 'EOF'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { MG_REPO: repo, MG_STAGE: stage } = process.env
const files = { 'dist/plugin.js': path.join(stage, 'dist', 'plugin.js'), 'skin/monograph.yaml': path.join(stage, 'skin', 'monograph.yaml') }
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// [what, RegExp]
const needles = []
const literal = (what, text) => {
  if (text && text.trim().length >= 3) {
    needles.push([what, new RegExp(escape(text.trim()), 'i')])
  }
}

literal('login name', process.env.MG_USER)
literal('home folder', os.homedir())
literal('git user.name', process.env.MG_GIT_NAME)
literal('git user.email', process.env.MG_GIT_EMAIL)
needles.push(['a home path', /\/(?:Users|home)\/[A-Za-z0-9._-]+/])
needles.push(['a Hermes session id', /\blocal-[0-9a-f]{16,}\b|\b20\d{6}_\d{6}_[0-9a-f]{6}\b/])

// config.local.json: settings keys whose values are enums are not personal;
// everything else (name, avatar, greeting, pinned, knowledge, ...) is.
const NOT_PERSONAL = { tools: ['shown', 'hidden'], motion: ['on', 'off'], density: ['comfortable', 'compact'] }
const localFile = path.join(repo, 'config.local.json')
let local = {}

if (fs.existsSync(localFile)) {
  try {
    local = JSON.parse(fs.readFileSync(localFile, 'utf8'))
  } catch (error) {
    console.error(`release-check: config.local.json does not parse: ${error.message}`)
    process.exit(2)
  }
}

const strings = (value, out = []) => {
  if (typeof value === 'string') {
    out.push(value)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      strings(item, out)
    }
  }

  return out
}

for (const [key, value] of Object.entries(local)) {
  if (key === 'addons') {
    for (const addon of value ?? []) {
      needles.push([`add-on ${addon} from config.local.json`, new RegExp(escape(`src/css/addons/${addon}.css`))])
    }
  } else if (!(NOT_PERSONAL[key] ?? []).includes(value)) {
    for (const text of strings(value)) {
      // A data URI (an avatar) is matched on a slice of its body.
      literal(`config.local.json "${key}"`, text.startsWith('data:') ? text.slice(-64) : text)
    }
  }
}

let found = 0

for (const [label, file] of Object.entries(files)) {
  const text = fs.readFileSync(file, 'utf8')

  for (const [what, pattern] of needles) {
    const match = text.match(pattern)

    if (match) {
      found++
      const at = match.index
      const around = text.slice(Math.max(0, at - 40), at + match[0].length + 40).replace(/\s+/g, ' ')
      console.log(`FOUND ${what} in ${label}: ...${around}...`)
    }
  }
}

console.log(`release-check: ${needles.length} patterns, ${Object.keys(files).length} files, ${found ? `${found} found` : 'nothing personal found'}`)
process.exit(found ? 1 : 0)
EOF
