#!/bin/sh
# Runs one command while holding one of the machine-wide rig slots, so that rig
# runs from different worktrees or agents never pile up: each opens an app
# window, several checks are timed, and a window hidden behind another one
# stops drawing.
#
#   rig/locked.sh node rig/run.mjs --simple
#
# There are MG_RIG_SLOTS slots (default 6). The slot number is handed on as
# MG_RIG_SLOT; the harness puts the window of slot n in its own place on the
# screen. Waits up to MG_RIG_LOCK_WAIT seconds (default 1800) for a free slot,
# then exits 3. A slot whose holder is gone is taken over. The command's own
# exit code is passed through.
LOCK="${MG_RIG_LOCK:-$HOME/.hermes/cache/scratch/mg-rig.lock}"
SLOTS="${MG_RIG_SLOTS:-6}"
WAIT="${MG_RIG_LOCK_WAIT:-1800}"
start=$(date +%s)
slot=""

mkdir -p "$(dirname "$LOCK")"

while [ -z "$slot" ]; do
  n=0

  while [ "$n" -lt "$SLOTS" ]; do
    dir="$LOCK.$n"

    if mkdir "$dir" 2>/dev/null; then
      slot=$n
      break
    fi

    holder=$(cat "$dir/pid" 2>/dev/null)

    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
      # The holder is gone: free the slot and try it again at once.
      rm -rf "$dir"
      continue
    fi

    # Taken but never signed: the taker died between the two steps.
    if [ -z "$holder" ] && [ -n "$(find "$dir" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      rm -rf "$dir"
      continue
    fi

    n=$((n + 1))
  done

  if [ -z "$slot" ]; then
    if [ $(( $(date +%s) - start )) -ge "$WAIT" ]; then
      echo "rig lock: all $SLOTS slots still held after ${WAIT}s" >&2
      exit 3
    fi

    sleep 3
  fi
done

echo $$ > "$LOCK.$slot/pid"
trap 'rm -rf "$LOCK.$slot"' EXIT
trap 'exit 130' INT TERM

MG_RIG_SLOT=$slot "$@"
exit $?
