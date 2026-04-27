# Troubleshooting: Orphan `email-mcp` Processes

## Symptom

The MCP host (Claude Code, Claude Desktop, etc.) reports that the email
server has disconnected mid-session and `mcp__email__*` tools become
unavailable. The disconnect tends to recur — sometimes within a single
working day — and `ps aux | grep email-mcp` shows many `node
/usr/local/bin/email-mcp stdio` processes from prior sessions still
alive, dating back days or weeks.

## Root Cause

When the MCP host process exits (session restart, host crash, fast-mode
toggle, etc.) the `email-mcp` child process does not always exit with
it. The orphan continues to hold its IMAP IDLE sockets open against the
configured mail servers. Because IMAP servers cap concurrent connections
per user, the orphans eventually crowd out the *next* session's
connection attempt, or the upstream resets a connection mid-call and
the JSON-RPC stream over stdio breaks. The host then reports the
server as disconnected.

The accumulation is the load-bearing problem. A single orphan is
harmless; a dozen across two weeks is not.

## Diagnosis

```sh
ps aux | grep email-mcp | grep -v grep
```

If you see more `node /usr/local/bin/email-mcp stdio` rows than active
MCP-host sessions, the host you are using is leaking child processes
on exit.

You can also confirm by start time — orphans will have `STARTED`
timestamps from previous days.

## Fix: Wrapper Script

The repository ships a small bash wrapper at
[`bin/email-mcp-wrapper.sh`](../bin/email-mcp-wrapper.sh) that ensures
the child dies when its parent does, regardless of how the parent
exited.

What the wrapper does:

1. Records `$PPID` (the MCP host process) at startup.
2. Spawns `email-mcp` with stdio inherited so the JSON-RPC stream is
   unchanged from the host's perspective.
3. Forwards `SIGTERM`, `SIGINT`, `SIGHUP`, and normal `EXIT` to the
   child via a `trap`.
4. Spawns a background watchdog that polls the recorded parent PID.
   When the parent disappears, the watchdog `SIGTERM`s and then
   `SIGKILL`s the `email-mcp` child. This survives even a `SIGKILL`
   of the wrapper itself, since the watchdog is reparented to launchd
   and continues running.

The wrapper is intentionally bash-only — no Node, no extra deps — so
it has nothing to break and nothing to keep up to date with the
underlying email-mcp version.

## Installation

The wrapper is shipped pre-built. Make it executable (already done
in-tree) and point your MCP host at it instead of the bare
`email-mcp` binary.

### Claude Code (`~/.claude.json`) — example

```json
{
  "mcpServers": {
    "email": {
      "type": "stdio",
      "command": "/Users/<you>/code/email-mcp/bin/email-mcp-wrapper.sh",
      "args": ["stdio"],
      "env": {}
    }
  }
}
```

The `args` array is forwarded to `email-mcp` unchanged. Any
environment overrides set on the MCP entry are inherited by the
wrapper and passed through.

### Override the wrapped binary

By default the wrapper invokes `/usr/local/bin/email-mcp`. To use a
different path (a checked-out source build, a globally pnpm-linked
binary, etc.) set `EMAIL_MCP_BIN`:

```json
"env": { "EMAIL_MCP_BIN": "/Users/<you>/code/email-mcp/dist/main.js" }
```

After updating the MCP host config, restart the host. The change does
not take effect on a running process — the running process is still
bound to the old `command`.

## Verification

After your next host restart:

```sh
ps -o pid,ppid,etime,command -p $(pgrep -f email-mcp-wrapper.sh)
ps aux | grep email-mcp | grep -v grep
```

You should see exactly one `email-mcp-wrapper.sh` per active MCP host
process, each with one `node /usr/local/bin/email-mcp stdio` child
beneath it. When the host exits, both should disappear within a few
seconds.

If orphans still accumulate, check that:

- The MCP host config is actually pointing at the wrapper (a stale
  process started before the config change will keep its old command).
- The wrapper file is executable (`chmod +x bin/email-mcp-wrapper.sh`).
- `$PPID` inside the wrapper is the MCP host, not an intermediate
  shell (typically true; verify with `ps -o pid,ppid,command -p
  <wrapper-pid>` if in doubt).

## One-Time Cleanup

To clear an existing pile of orphans without restarting the host:

```sh
# List candidates
ps aux | grep "email-mcp stdio" | grep -v grep

# Identify the PIDs of the *current* session (newest, attached to your
# active host's terminal/tty) and KEEP those.

# Kill the rest
kill -9 <orphan-pids...>
```

`kill -TERM` is preferable but orphans wedged in IMAP I/O sometimes
ignore it; `-9` is appropriate for known-orphan processes.
