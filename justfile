set positional-arguments := true

_default:
    @just --list

# Install Monograph. Pass --full for the extras and settings.
install *args:
    ./install.sh "$@"

# Fast-forward the tracked branch, then reinstall with the supplied options.
update *args:
    git pull --ff-only
    ./install.sh "$@"

# Uninstall Monograph and restore any files it replaced.
uninstall:
    ./install.sh --uninstall
