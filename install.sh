#!/bin/sh
# Monograph installer.
#
#   ./install.sh               build a release and install the plugin and the skin
#   ./install.sh --local       build with config.local.json (your defaults and add-ons)
#   ./install.sh --no-skin     install the plugin only
#   ./install.sh --uninstall   put back what was there before Monograph
#   ./install.sh --help
#
# Installs into $HERMES_HOME (default ~/.hermes):
#   desktop-plugins/monograph/plugin.js   the plugin (Hermes loads it on its own)
#   skins/monograph.yaml                  the colours-only skin
# and keeps its records in $HERMES_HOME/monograph-install/:
#   original/   each file as it was before the first install (or a note that
#               there was none), which --uninstall puts back
#   installed/  a copy of what was installed last, to tell later edits apart
#   previous/   the version the last update replaced
#
# Safe to run again: a file that would not change is left alone. It never
# edits Hermes' config; it prints the one command that turns the skin on.
set -eu

repo=$(cd "$(dirname "$0")" && pwd)
home=${HERMES_HOME:-$HOME/.hermes}
state="$home/monograph-install"
stamp=$(date +%Y%m%d-%H%M%S)

mode=install
build=release
skin=yes

for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    --local) build=local ;;
    --no-skin) skin=no ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "install.sh: unknown option $arg (see --help)" >&2
      exit 64
      ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# The files, as "relative path in the Hermes home".
PLUGIN_REL=desktop-plugins/monograph/plugin.js
SKIN_REL=skins/monograph.yaml

# ── Preflight ───────────────────────────────────────────────────────────────
# A Hermes home holds config.yaml once Hermes has run, or the hermes-agent
# checkout of a source install. Anything else is not one, and nothing is
# written into it.
if [ ! -d "$home" ] || { [ ! -f "$home/config.yaml" ] && [ ! -d "$home/hermes-agent" ]; }; then
  fail "no Hermes home at $home (no config.yaml, no hermes-agent). Install Hermes and start it once, or point HERMES_HOME at your Hermes home. Nothing was changed."
fi

# ── Uninstall ───────────────────────────────────────────────────────────────
if [ "$mode" = uninstall ]; then
  if [ ! -d "$state" ]; then
    say "Nothing to uninstall: no install record at $state. Nothing was changed."
    exit 0
  fi

  say "Uninstalling Monograph from $home"

  for rel in "$PLUGIN_REL" "$SKIN_REL"; do
    dst="$home/$rel"

    # A file changed by hand since the install is kept, not lost.
    if [ -f "$dst" ] && [ -f "$state/installed/$rel" ] && ! cmp -s "$dst" "$state/installed/$rel"; then
      keep="$home/monograph-uninstalled-$stamp/$rel"
      mkdir -p "$(dirname "$keep")"
      cp -p "$dst" "$keep"
      say "  kept      $keep  (it had been changed since the install)"
    fi

    if [ -f "$state/original/$rel" ]; then
      mkdir -p "$(dirname "$dst")"
      cat "$state/original/$rel" > "$dst"
      say "  restored  $dst  (the file from before Monograph)"
    elif [ -f "$state/original/$rel.absent" ]; then
      if [ -e "$dst" ]; then
        rm -f "$dst"
        say "  removed   $dst"
      else
        say "  absent    $dst  (already gone)"
      fi
    else
      say "  untouched $dst  (Monograph never installed it)"
    fi
  done

  # Folders Monograph made go too, if nothing else has moved in. Deepest
  # first: the list holds each folder before its parent.
  if [ -f "$state/created-dirs" ]; then
    while IFS= read -r rel; do
      [ -n "$rel" ] && rmdir "$home/$rel" 2> /dev/null && say "  removed   $home/$rel/"
    done < "$state/created-dirs"
  fi
  rm -rf "$state"
  say "  removed   $state"

  if grep -Eq '^[[:space:]]*skin:[[:space:]]*["'\'']?monograph["'\'']?[[:space:]]*$' "$home/config.yaml" 2>/dev/null; then
    say ""
    say "Your config still names the monograph skin, which is gone now. To pick another:"
    say "  hermes config set display.skin default"
  fi

  say "Done. A running Hermes drops the plugin within a few seconds."
  exit 0
fi

# ── Install: build ──────────────────────────────────────────────────────────
command -v node > /dev/null 2>&1 || fail "node is not installed. It builds the plugin; install Node 18 or later and run again. Nothing was changed."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' ||
  fail "node $(node --version) is too old; Node 18 or later builds the plugin. Nothing was changed."

[ -f "$repo/build.mjs" ] && [ -d "$repo/src" ] && [ -f "$repo/skin/monograph.yaml" ] ||
  fail "this does not look like a Monograph checkout: $repo (no build.mjs, src/ or skin/). Nothing was changed."

# Build from a copy of the sources, so this checkout's own dist/ is neither
# read nor replaced.
stage=$(mktemp -d "${TMPDIR:-/tmp}/monograph-build.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 130' INT TERM

cp -R "$repo/build.mjs" "$repo/package.json" "$repo/src" "$repo/skin" "$stage/"
mkdir -p "$stage/scripts"
cp "$repo/scripts/doctor.mjs" "$stage/scripts/"
cp "$repo/selectors.json" "$stage/"

if [ "$build" = local ]; then
  [ -f "$repo/config.local.json" ] || fail "--local needs config.local.json in $repo. Nothing was changed."
  cp "$repo/config.local.json" "$stage/"
  flag=""
else
  flag="--release"
fi

# HERMES_HOME points into the stage: build.mjs installs only when asked to,
# and this keeps even a mistake away from the real home.
if ! out=$(cd "$stage" && HERMES_HOME="$stage/no-install" node build.mjs $flag 2>&1); then
  printf '%s\n' "$out" >&2
  fail "the build failed (above). Nothing was changed."
fi

node --check "$stage/dist/plugin.js" 2> /dev/null || fail "the built plugin does not parse. Nothing was changed."
say "Built $(printf '%s\n' "$out" | sed -n '1s/^built dist\/plugin.js *//p')  ($build build)"

# ── Install: copy ───────────────────────────────────────────────────────────
say "Installing into $home"
mkdir -p "$state/original" "$state/installed"

install_file() {
  src=$1
  rel=$2
  dst="$home/$rel"

  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    # Already the same file. If it was put there some other way (build.mjs
    # --install), it still counts as what was there before Monograph.
    if [ ! -e "$state/original/$rel" ] && [ ! -e "$state/original/$rel.absent" ]; then
      mkdir -p "$(dirname "$state/original/$rel")"
      cp -p "$dst" "$state/original/$rel"
    fi

    say "  unchanged $dst"
  else
    if [ -e "$dst" ]; then
      if [ ! -e "$state/original/$rel" ] && [ ! -e "$state/original/$rel.absent" ]; then
        # First install over a file that is not ours: it is what --uninstall
        # puts back.
        mkdir -p "$(dirname "$state/original/$rel")"
        cp -p "$dst" "$state/original/$rel"
        how="replaced  $dst  (the old file is kept in $state/original/)"
      elif [ -f "$state/installed/$rel" ] && cmp -s "$dst" "$state/installed/$rel"; then
        mkdir -p "$(dirname "$state/previous/$rel")"
        cp -p "$dst" "$state/previous/$rel"
        how="updated   $dst  (the version it replaced is in $state/previous/)"
      else
        keep="$state/replaced-$stamp/$rel"
        mkdir -p "$(dirname "$keep")"
        cp -p "$dst" "$keep"
        how="replaced  $dst  (it had been changed since the last install; kept in $state/replaced-$stamp/)"
      fi
    else
      if [ ! -e "$state/original/$rel" ] && [ ! -e "$state/original/$rel.absent" ]; then
        mkdir -p "$(dirname "$state/original/$rel")"
        : > "$state/original/$rel.absent"
      fi

      how="created   $dst"
    fi

    # Folders made here are noted, so that --uninstall can take them away.
    dir=$(dirname "$dst")
    while [ ! -d "$dir" ] && [ "$dir" != "$home" ]; do
      printf '%s\n' "${dir#"$home"/}" >> "$state/created-dirs"
      dir=$(dirname "$dir")
    done

    # Truncate and write rather than replace: Hermes' hot reload watches the
    # file itself.
    mkdir -p "$(dirname "$dst")"
    cat "$src" > "$dst"
    say "  $how"
  fi

  mkdir -p "$(dirname "$state/installed/$rel")"
  cp "$src" "$state/installed/$rel"
}

install_file "$stage/dist/plugin.js" "$PLUGIN_REL"

if [ "$skin" = yes ]; then
  install_file "$stage/skin/monograph.yaml" "$SKIN_REL"
fi

# ── Doctor ──────────────────────────────────────────────────────────────────
# Which hooks the stylesheet leans on are still in this Hermes. Needs Hermes'
# desktop source (a source install has it); without it the check is skipped.
say ""
set +e
doctor=$(cd "$stage" && node scripts/doctor.mjs 2>&1)
code=$?
set -e

case $code in
  0) say "Doctor: $(printf '%s\n' "$doctor" | head -1)" ;;
  1)
    say "Doctor: $(printf '%s\n' "$doctor" | head -1)"
    printf '%s\n' "$doctor" | sed -n '2,$p' | grep MISSING | sed 's/^ */  /'
    say "  Monograph is installed. The parts that lean on a missing hook keep Hermes' own look until Monograph catches up with this Hermes."
    ;;
  *) say "Doctor: skipped. $(printf '%s\n' "$doctor" | head -1 | sed 's/^doctor: //')" ;;
esac

# ── Next ────────────────────────────────────────────────────────────────────
say ""
say "Done. A running Hermes picks the plugin up within a few seconds; otherwise at its next start."

if [ "$skin" = yes ] && ! grep -Eq '^[[:space:]]*skin:[[:space:]]*["'\'']?monograph["'\'']?[[:space:]]*$' "$home/config.yaml" 2> /dev/null; then
  say "Turn the colours on:   hermes config set display.skin monograph"
fi

say "Undo:                  $repo/install.sh --uninstall"
