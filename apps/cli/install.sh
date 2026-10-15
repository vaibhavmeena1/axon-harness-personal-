#!/bin/sh

set -eu
set -f

PROGRAM=axon
TARGET=darwin-arm64
ARCHIVE_NAME=axon-darwin-arm64.gz
BINARY_ASSET_NAME=axon-darwin-arm64
# The backend substitutes this default when serving /install.sh.
# When running this source file directly, set _AXON_RELEASES_URL to your backend's HTTPS release endpoint.
DEFAULT_RELEASES_URL='https://YOUR_ORIGIN/api/v1/cli/releases'
RELEASES_URL=${_AXON_RELEASES_URL:-$DEFAULT_RELEASES_URL}

VERSION_FILE=
CHECKSUMS_FILE=
ARCHIVE_FILE=
STAGED_BINARY=
BACKUP_TEMP=

say() {
  printf '%s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [ -z "$VERSION_FILE" ] || rm -f "$VERSION_FILE"
  [ -z "$CHECKSUMS_FILE" ] || rm -f "$CHECKSUMS_FILE"
  [ -z "$ARCHIVE_FILE" ] || rm -f "$ARCHIVE_FILE"
  [ -z "$STAGED_BINARY" ] || rm -f "$STAGED_BINARY"
  [ -z "$BACKUP_TEMP" ] || rm -f "$BACKUP_TEMP"
}

trap cleanup 0
trap 'exit 1' 1 2 15

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "required tool is not available: $1"
}

pi_runtime_ready() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' >/dev/null 2>&1 &&
    command -v npm >/dev/null 2>&1 &&
    npm --version >/dev/null 2>&1
}

ensure_pi_runtime() {
  if pi_runtime_ready; then
    say "Node.js 22.19+ and npm are available for Pi."
    return
  fi

  if ! command -v brew >/dev/null 2>&1; then
    die "Pi requires Node.js 22.19+ and npm. Install them from https://nodejs.org/ or install Homebrew, then run this installer again"
  fi
  if ! [ -r /dev/tty ] || ! [ -w /dev/tty ]; then
    die "Pi requires Node.js 22.19+ and npm. Run this installer in an interactive terminal to install them with Homebrew, or install them first and retry"
  fi

  printf 'Pi requires Node.js 22.19+ and npm. Install or upgrade Node.js with Homebrew now? [Y/n] ' > /dev/tty
  IFS= read -r answer < /dev/tty || die "could not read confirmation for Node.js installation"
  case "$answer" in
    ''|y|Y|yes|YES) ;;
    *) die "Node.js installation declined; install Node.js 22.19+ and npm, then retry" ;;
  esac

  if brew list node >/dev/null 2>&1; then
    brew upgrade node || die "Homebrew could not upgrade Node.js"
  else
    brew install node || die "Homebrew could not install Node.js"
  fi
  pi_runtime_ready || die "Node.js 22.19+ and npm are not on PATH after Homebrew installation; configure Homebrew's shell environment and retry"
  say "Node.js 22.19+ and npm are available for Pi."
}

download() {
  source_url=$1
  destination=$2
  curl \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --location \
    --fail \
    --silent \
    --show-error \
    --output "$destination" \
    "$source_url"
}

validate_sha256() {
  hash=$1
  [ "${#hash}" -eq 64 ] || return 1
  case "$hash" in
    *[!0-9a-f]*) return 1 ;;
  esac
  return 0
}

sha256_file() {
  shasum -a 256 < "$1" | awk '{ print $1 }'
}

get_expected_hash() {
  asset_name=$1
  checksum_file=$2
  hash=$(awk -v name="$asset_name" '$2 == name && NF == 2 { print $1 }' "$checksum_file")
  validate_sha256 "$hash" || die "checksums.txt has no unique valid SHA-256 for $asset_name"
  printf '%s\n' "$hash"
}

# Quote literal paths for shell startup files, including spaces, quotes and '$'.
quote_path() {
  printf '%s' "$1" | awk -v shell="$2" '
    BEGIN { printf "%c", 39 }
    {
      if (NR > 1) printf "\n"
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == sprintf("%c", 39)) {
          if (shell == "fish") printf "\\%c", 39
          else printf "%c\\%c%c", 39, 39, 39
        } else if (c == "\\" && shell == "fish") printf "\\\\"
        else printf "%s", c
      }
    }
    END { printf "%c", 39 }
  '
}

append_path_config() {
  config_file=$1
  config_parent=${config_file%/*}
  if ! mkdir -p "$config_parent"; then
    warn "could not create shell configuration directory: $config_parent"
    return
  fi
  if [ -f "$config_file" ] && grep -Fqx -- "$PATH_ENTRY" "$config_file"; then
    return
  fi
  if printf '\n# Axon CLI\n%s\n' "$PATH_ENTRY" >> "$config_file"; then
    say "Configured Axon PATH in $config_file"
  else
    warn "could not update $config_file; add the printed PATH command manually"
  fi
}

configure_shell_path() {
  # This script runs under sh; SHELL identifies the user's shell instead.
  LOGIN_SHELL=${SHELL:-}
  LOGIN_SHELL=${LOGIN_SHELL##*/}
  QUOTED_BIN=$(quote_path "$BIN_DIR" "$LOGIN_SHELL")
  case "$LOGIN_SHELL" in
    fish)
      PATH_COMMAND="set -gx PATH $QUOTED_BIN \$PATH"
      PATH_ENTRY="if not contains -- $QUOTED_BIN \$PATH; $PATH_COMMAND; end"
      append_path_config "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"
      ;;
    zsh)
      PATH_COMMAND="export PATH=$QUOTED_BIN:\"\$PATH\""
      PATH_ENTRY="case \":\$PATH:\" in *:$QUOTED_BIN:*) ;; *) $PATH_COMMAND ;; esac"
      append_path_config "${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      PATH_COMMAND="export PATH=$QUOTED_BIN:\"\$PATH\""
      PATH_ENTRY="case \":\$PATH:\" in *:$QUOTED_BIN:*) ;; *) $PATH_COMMAND ;; esac"
      append_path_config "$HOME/.bashrc"
      # Bash login shells read only the first existing file in this list.
      if [ -f "$HOME/.bash_profile" ]; then
        append_path_config "$HOME/.bash_profile"
      elif [ -f "$HOME/.bash_login" ]; then
        append_path_config "$HOME/.bash_login"
      elif [ -f "$HOME/.profile" ]; then
        append_path_config "$HOME/.profile"
      else
        append_path_config "$HOME/.bash_profile"
      fi
      ;;
    sh|dash|ksh|'')
      PATH_COMMAND="export PATH=$QUOTED_BIN:\"\$PATH\""
      PATH_ENTRY="case \":\$PATH:\" in *:$QUOTED_BIN:*) ;; *) $PATH_COMMAND ;; esac"
      append_path_config "$HOME/.profile"
      ;;
    *)
      warn "automatic PATH configuration is not supported for $LOGIN_SHELL; add $BIN_DIR to your shell's PATH"
      PATH_COMMAND=
      ;;
  esac
}

OS_NAME=$(uname -s)
ARCH_NAME=$(uname -m)
[ "$OS_NAME" = "Darwin" ] || die "unsupported operating system: $OS_NAME (macOS is required)"
[ "$ARCH_NAME" = "arm64" ] || die "unsupported architecture: $ARCH_NAME (Apple Silicon arm64 is required)"

if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -n "${container:-}" ]; then
  die "container execution is not supported"
fi

for tool in uname curl grep awk shasum gzip codesign chmod mkdir mktemp cp mv rm; do
  require_tool "$tool"
done

ensure_pi_runtime

case "$RELEASES_URL" in
  https://*) ;;
  *) die "release URL must use HTTPS" ;;
esac
case "$RELEASES_URL" in
  */) die "release URL must not have a trailing slash" ;;
esac

: "${HOME:?HOME must be set}"
MANAGED_HOME=${AXON_HOME:-"$HOME/.axon"}
case "$MANAGED_HOME" in
  /*) ;;
  *) die "AXON_HOME must be an absolute path" ;;
esac

BIN_DIR=$MANAGED_HOME/bin
BINARY=$BIN_DIR/$PROGRAM
PREVIOUS_BINARY=$BIN_DIR/$PROGRAM.prev

umask 077
mkdir -p "$MANAGED_HOME" "$BIN_DIR"
chmod 700 "$MANAGED_HOME" "$BIN_DIR"

VERSION_FILE=$(mktemp "$BIN_DIR/.axon-version.XXXXXX")
CHECKSUMS_FILE=$(mktemp "$BIN_DIR/.axon-checksums.XXXXXX")
ARCHIVE_FILE=$(mktemp "$BIN_DIR/.axon-archive.XXXXXX")
STAGED_BINARY=$(mktemp "$BIN_DIR/.axon-install.XXXXXX")

say "Resolving the latest axon release..."
download "$RELEASES_URL/latest/VERSION" "$VERSION_FILE" || die "could not download the latest VERSION asset"

VERSION=
VERSION_LINE_COUNT=0
while IFS= read -r line || [ -n "$line" ]; do
  VERSION_LINE_COUNT=$((VERSION_LINE_COUNT + 1))
  [ "$VERSION_LINE_COUNT" -eq 1 ] || die "VERSION asset must contain exactly one line"
  VERSION=$line
done < "$VERSION_FILE"
[ "$VERSION_LINE_COUNT" -eq 1 ] || die "VERSION asset is empty"

SEMVER_PATTERN='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
printf '%s\n' "$VERSION" | grep -Eq "$SEMVER_PATTERN" || die "VERSION is not canonical semantic version syntax: $VERSION"

# Pin all remaining requests to the version resolved above, never to mutable latest.
EXACT_RELEASE_URL=$RELEASES_URL/$VERSION
say "Downloading axon $VERSION for $TARGET..."
download "$EXACT_RELEASE_URL/checksums.txt" "$CHECKSUMS_FILE" || die "could not download checksums.txt for $VERSION"
download "$EXACT_RELEASE_URL/$ARCHIVE_NAME" "$ARCHIVE_FILE" || die "could not download $ARCHIVE_NAME for $VERSION"

EXPECTED_ARCHIVE_HASH=$(get_expected_hash "$ARCHIVE_NAME" "$CHECKSUMS_FILE")
ACTUAL_ARCHIVE_HASH=$(sha256_file "$ARCHIVE_FILE")
[ "$ACTUAL_ARCHIVE_HASH" = "$EXPECTED_ARCHIVE_HASH" ] || die "compressed SHA-256 mismatch for $ARCHIVE_NAME"

if ! gzip -dc "$ARCHIVE_FILE" > "$STAGED_BINARY"; then
  die "downloaded archive is not valid gzip data"
fi

EXPECTED_BINARY_HASH=$(get_expected_hash "$BINARY_ASSET_NAME" "$CHECKSUMS_FILE")
ACTUAL_BINARY_HASH=$(sha256_file "$STAGED_BINARY")
[ "$ACTUAL_BINARY_HASH" = "$EXPECTED_BINARY_HASH" ] || die "decompressed SHA-256 mismatch for $BINARY_ASSET_NAME"

chmod 755 "$STAGED_BINARY"
if ! codesign --verify --verbose=2 "$STAGED_BINARY"; then
  die "the staged executable has an invalid code signature"
fi

if ! STAGED_VERSION=$("$STAGED_BINARY" --version 2>/dev/null); then
  die "the staged executable did not run successfully"
fi
[ "$STAGED_VERSION" = "$VERSION" ] || die "staged executable reports $STAGED_VERSION, expected $VERSION"

if [ -e "$BINARY" ]; then
  [ -f "$BINARY" ] || die "existing managed path is not a regular file: $BINARY"
  BACKUP_TEMP=$(mktemp "$BIN_DIR/.axon-backup.XXXXXX")
  cp -p "$BINARY" "$BACKUP_TEMP" || die "could not preserve the existing installation"
  mv -f "$BACKUP_TEMP" "$PREVIOUS_BINARY" || die "could not activate the installation backup"
  BACKUP_TEMP=
fi

mv -f "$STAGED_BINARY" "$BINARY" || die "could not atomically activate axon"
STAGED_BINARY=

say "Installed axon $VERSION at $BINARY"
[ ! -e "$PREVIOUS_BINARY" ] || say "Previous installation preserved at $PREVIOUS_BINARY"

case ":${PATH:-}:" in
  *":$BIN_DIR:"*) PATH_HAS_MANAGED_BIN=1 ;;
  *) PATH_HAS_MANAGED_BIN=0 ;;
esac

configure_shell_path

RESOLVED_COMMAND=$(command -v "$PROGRAM" 2>/dev/null || true)
if [ -n "$RESOLVED_COMMAND" ] && [ "$RESOLVED_COMMAND" != "$BINARY" ]; then
  warn "$PROGRAM currently resolves to $RESOLVED_COMMAND instead of $BINARY"
fi

if [ "$PATH_HAS_MANAGED_BIN" -eq 0 ]; then
  say "Restart your terminal to use axon."
  if [ -n "$PATH_COMMAND" ]; then
    say "Or enable it in your current shell now:"
    printf '  %s\n' "$PATH_COMMAND"
  fi
fi

if command -v pi >/dev/null 2>&1; then
  say "Detected Pi: $(command -v pi)"
else
  say "Pi is not bundled; axon pi will install its pinned Pi release on first use."
fi

if [ "$PATH_HAS_MANAGED_BIN" -eq 1 ]; then
  say "Next, run: axon doctor"
else
  say "After updating PATH, run: axon doctor"
fi
