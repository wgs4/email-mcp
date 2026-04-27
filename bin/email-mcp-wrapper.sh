#!/bin/bash
# Wrapper for /usr/local/bin/email-mcp.
#
# Why: orphan email-mcp processes were piling up — Claude Code spawns the MCP
# but on session end the child does not exit, leaving open IMAP connections
# that eventually exhaust per-user limits and break the *next* session.
#
# What this does:
#   1. Records the parent PID (Claude Code) at startup.
#   2. Spawns email-mcp with stdio inherited so JSON-RPC works unchanged.
#   3. Runs a background watchdog that polls the parent PID; when the parent
#      goes away, it SIGTERMs (then SIGKILLs) the email-mcp child even if
#      this wrapper itself was SIGKILLed.
#   4. On normal exit / signal, forwards termination to the child.

set -u

EMAIL_MCP_BIN="${EMAIL_MCP_BIN:-/usr/local/bin/email-mcp}"
PARENT_PID=$PPID

"$EMAIL_MCP_BIN" "$@" &
CHILD_PID=$!

kill_child() {
  if kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    for _ in 1 2 3 4; do
      kill -0 "$CHILD_PID" 2>/dev/null || return 0
      sleep 0.5
    done
    kill -KILL "$CHILD_PID" 2>/dev/null || true
  fi
}

cleanup() {
  kill_child
  if [ -n "${MONITOR_PID:-}" ] && kill -0 "$MONITOR_PID" 2>/dev/null; then
    kill -TERM "$MONITOR_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT TERM INT HUP

(
  while kill -0 "$PARENT_PID" 2>/dev/null; do
    sleep 5
  done
  if kill -0 "$CHILD_PID" 2>/dev/null; then
    kill -TERM "$CHILD_PID" 2>/dev/null || true
    sleep 2
    kill -KILL "$CHILD_PID" 2>/dev/null || true
  fi
) &
MONITOR_PID=$!

wait "$CHILD_PID"
exit $?
