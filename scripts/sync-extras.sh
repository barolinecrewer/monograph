#!/bin/sh
# Copy the owner's companion plugins from the live Hermes home into extras/,
# so they ship with Monograph (./install.sh --full installs them).
# Personal data is stripped here (session-model-icons: profile photo and name).
# Typefully-panel and the Knowledge page are never shipped.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
home=${HERMES_HOME:-$HOME/.hermes}
out="$repo/extras"
rm -rf "$out"; mkdir -p "$out/desktop-plugins" "$out/plugins"

for p in bloub-bots bot-panel context-ring image-cards live-status session-model-icons; do
  mkdir -p "$out/desktop-plugins/$p"
  for f in "$home/desktop-plugins/$p"/*; do
    case "$(basename "$f")" in *.before-*) continue ;; esac
    cp "$f" "$out/desktop-plugins/$p/"
  done
done

for p in live-status session-model-icons live-retitle; do
  (cd "$home/plugins" && find "$p" -type f -not -path '*__pycache__*' -not -name '*.pyc') | while IFS= read -r f; do
    mkdir -p "$out/plugins/$(dirname "$f")"; cp "$home/plugins/$f" "$out/plugins/$f"
  done
done

# Strip the owner's photo and name; the footer shows a plain "You" instead.
smi="$out/desktop-plugins/session-model-icons/plugin.js"
node -e '
const fs=require("fs"),p=process.argv[1];let s=fs.readFileSync(p,"utf8");
s=s.replace(/const AVATAR = '"'"'data:[^'"'"']*'"'"'/,"const AVATAR = '"'"''"'"'").replace(/const USER_NAME = '"'"'[^'"'"']*'"'"'/,"const USER_NAME = '"'"'You'"'"'");
s=s.replace("me.appendChild(img); me.appendChild","if (AVATAR) me.appendChild(img); me.appendChild");
fs.writeFileSync(p,s)' "$smi"
grep -q "data:image" "$smi" && { echo "sync-extras: photo still in $smi" >&2; exit 1; }
echo "extras: $(find "$out" -type f | wc -l | tr -d ' ') files"
