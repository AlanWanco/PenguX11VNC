#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
exec cargo run --manifest-path src-tauri/Cargo.toml
