# bot-hq — findings

An open-source reproduction of Grok Bot. Read from docs and code; not run locally.

## Shape

Node server (Hono, SQLite, about 5.6k lines) plus a React and zustand web app. Each bot is a
Hermes agent; the server adds the chat interface, one Orgo cloud screen per bot, Composio
connected apps with approvals, routines, a Library and xAI voice.

## Worth keeping (the product layer)

- **Transcript model** (`server/src/types.ts`): append-mostly rows with `seq` and a per-bot
  `updatedSeq` revision counter; a streaming reply is the same row rewritten. Row kinds:
  message, tool-call, card (approval, question, connect, draft), event, notice.
- **Per-bot serial turn queue** and triggers (user, routine, bot, system):
  `server/src/agent/loop.ts`.
- **Live state**: what the bot is doing now, since when, step count (`LiveState`).
- **Approvals inside the tool call**: the call waits on a card; Allow, Always allow, Don't allow;
  a new user message expires pending cards.
- **App tools over MCP** (`server/src/mcp.ts`, `agent/tools.ts`): save_file, routines, tasks,
  check-ins, send_to_bot, groups, ask_user, stay_silent, request_app_connection.
- **System prompt addendum** kept byte-stable between turns for prompt caching
  (`agent/prompt.ts`).
- **Layout**: roster sidebar, chat with a "worked for 2m, 7 steps" chip, details panel.

## Dropping

Orgo screens, VNC viewer and screen dressing (`computer.ts`, `desk.ts`, `vnc.ts`, `box/`),
Hermes engines (`engine.ts`), Composio-managed Google sign-in, the four-bot limit.

## Limits to fix in ours

Approvals only covered Composio write actions, guessed by a regex on tool names; browser and
shell actions were ungated. Bots shared one computer and could read each other's files.

## Design note

The interface copies Grok Bot's look (blob avatars, pink and orange bubbles). We keep the
three-column idea for threads only and replace the whole identity.
