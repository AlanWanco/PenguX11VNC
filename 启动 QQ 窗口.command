#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"
exec python3 tools/launch.py "$@"
