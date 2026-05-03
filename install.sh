#!/bin/bash
# agent-runner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/deploy-sh/agent-runner/main/install.sh | bash
set -euo pipefail

REPO="deploy-sh/agent-runner"
BINARY="agent-runner-linux-x64"
RELEASE_URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"

# Install target
if [ "$EUID" -eq 0 ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

TARGET="${INSTALL_DIR}/agent-runner"

echo "agent-runner installer"
echo "Source: ${RELEASE_URL}"
echo "Target: ${TARGET}"
echo ""

# Check OS
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Linux" ]; then
  echo "ERROR: Only Linux is supported (got $OS)"
  exit 1
fi
if [ "$ARCH" != "x86_64" ]; then
  echo "WARN: Built for x86_64, got $ARCH — may not work"
fi

# Download
echo "[1/2] Downloading..."
if command -v curl &>/dev/null; then
  curl -fsSL --retry 3 --location -o "$TARGET" "$RELEASE_URL"
elif command -v wget &>/dev/null; then
  wget -qO "$TARGET" "$RELEASE_URL"
else
  echo "ERROR: curl or wget required"
  exit 1
fi
chmod +x "$TARGET"
echo "      OK"

# PATH check
echo "[2/2] PATH..."
if ! echo "$PATH" | grep -q "$INSTALL_DIR"; then
  SHELL_RC=""
  if [ -n "${BASH_VERSION:-}" ]; then
    SHELL_RC="$HOME/.bashrc"
  elif [ -n "${ZSH_VERSION:-}" ]; then
    SHELL_RC="$HOME/.zshrc"
  fi

  if [ -n "$SHELL_RC" ]; then
    if ! grep -q "$INSTALL_DIR" "$SHELL_RC" 2>/dev/null; then
      printf '\n# agent-runner\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$SHELL_RC"
      echo "      Added to $SHELL_RC"
    fi
  fi
  export PATH="${INSTALL_DIR}:${PATH}"
fi
echo "      OK ($(agent-runner --version 2>/dev/null || echo 'installed'))"

echo ""
echo "Done. Run:"
echo ""
echo "  agent-runner \"your prompt here\""
echo ""

# Suggest wizard if no key configured
if [ -z "${AGENT_API_KEY:-}" ] && [ ! -f "$HOME/.agent-runner/.env" ]; then
  echo "No API key found. Run the setup wizard:"
  echo ""
  echo "  agent-runner --setup"
  echo ""
fi
