# T3 Code — findings

Read from docs and code structure; not run locally.

## Size and shape

About 1.5M lines of TypeScript including tests (server 634k, web 425k, mobile 209k,
client-runtime 109k, desktop 80k, relay 30k). pnpm monorepo on Effect. Active daily.

- `apps/server` — owns providers, terminals, git, files, durable state (SQLite, event log plus
  projections).
- `apps/web` — React, TanStack Router, React Compiler enforced on every file.
- `apps/desktop` — Electron shell that bundles a server.
- `apps/mobile` — Expo / React Native with native modules, Clerk sign-in.
- `packages/client-runtime` — shared connection and state layer for web, desktop, mobile.
- `packages/contracts` — the RPC contract between clients and servers.
- `infra/relay` — T3 Connect relay (Cloudflare Worker, Postgres, Clerk).

## How it uses a Claude subscription

`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` (13.8k lines) drives
`@anthropic-ai/claude-agent-sdk`, which launches the user's installed, signed-in `claude`
(`pathToClaudeCodeExecutable`). A second account is another instance with its own
`CLAUDE_CONFIG_DIR`. Permissions map to SDK `permissionMode` and a `canUseTool` callback.
T3's own tools reach the agent as MCP servers. T3 deliberately has no account auto-switcher.
Docs: `docs/user/providers-claude.md`, `docs/user/faq.md`, `docs/internals/providers.md`.

## How other devices reach it

One server per machine ("environment"); every client is thin and talks authenticated RPC over
HTTP and WebSocket. Routes: LAN pairing (one-time code or QR), Tailscale HTTPS
(`t3 serve --tailscale-serve`), SSH, or T3 Connect (Clerk identity plus a Cloudflare tunnel;
the relay brokers credentials and does not proxy traffic). Background service via launchd,
systemd or Task Scheduler. Push notifications require T3 Connect.
Docs: `docs/internals/remote.md`, `environment-auth.md`, `t3-connect.md`,
`docs/user/remote-access.md`, `background-service.md`.

Auth model worth copying: pairing delegates scopes; sessions are scoped; WebSocket upgrades use
short-lived tickets so long-lived tokens stay out of URLs; every RPC declares a required scope.

## Why it feels fast

From `docs/internals/performance-regressions.md`, `connection-runtime.md`, `web-ui.md`:

- Cold opens are bounded windows (about 1 MiB or 10 user turns); older history pages on demand.
- Reconnect resumes from a cursor with deltas instead of a new snapshot.
- Tool output bodies stay off the wire until a row is expanded; live command output is a
  separate throttled subscription.
- Streaming text deltas are coalesced.
- Cached state is shown immediately; the shell snapshot loads over HTTP before the socket is up.
- Thread state is cached for five idle minutes so back navigation is instant.
- One connection supervisor per environment; foregrounding probes the socket and replaces a
  dead one within seconds; jittered backoff.
- Virtualized lists; React Compiler everywhere.
- Payload and timing budgets enforced in tests.

## Other things it has that we may want later

Scheduled tasks and webhooks (`apps/server/src/scheduledTasks`), an orchestrator MCP server so
outside agents can start and read threads (`docs/user/outside-agents.md`), voice dictation
(`apps/server/src/speech`), checkpoints as hidden git refs.
