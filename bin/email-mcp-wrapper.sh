#!/bin/bash
# Wrapper for /usr/local/bin/email-mcp.
#
# Why: orphan email-mcp processes were piling up — Claude Code spawns the MCP
# but on session end the child does not exit, leaving open IMAP connections
# that eventually exhaust per-user limits and break the *next* session.
#
# What this does:
#   1. Records the parent PID (the MCP host) at startup.
#   2. Detaches a watchdog subshell with stdio redirected to /dev/null so it
#      cannot interfere with the JSON-RPC pipe.
#   3. `exec`s email-mcp in place — bash is replaced, so email-mcp inherits
#      the host's stdin/stdout/stderr directly with the same PID. There is
#      no shell layer between host and child.
#   4. The watchdog polls the recorded parent PID. When the parent goes away
#      it SIGTERMs (then SIGKILLs) email-mcp by the wrapper's original PID
#      (= email-mcp's PID after exec). It also self-exits if email-mcp dies
#      first, so the watchdog never lingers.

set -u

EMAIL_MCP_BIN="${EMAIL_MCP_BIN:-/usr/local/bin/email-mcp}"
PARENT_PID=$PPID
SELF_PID=$$

(
  while kill -0 "$PARENT_PID" 2>/dev/null; do
    kill -0 "$SELF_PID" 2>/dev/null || exit 0
    sleep 5
  done
  if kill -0 "$SELF_PID" 2>/dev/null; then
    kill -TERM "$SELF_PID" 2>/dev/null || true
    sleep 2
    kill -KILL "$SELF_PID" 2>/dev/null || true
  fi
) </dev/null >/dev/null 2>&1 &

exec "$EMAIL_MCP_BIN" "$@"
