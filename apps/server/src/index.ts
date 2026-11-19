import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAdaptorServer } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { ClaudeEngine } from './engine/claude.ts';
import { DemoEngine } from './engine/demo.ts';
import { createHttp } from './http.ts';
import { attachSync } from './ws.ts';

const demo = process.env.BUREAU_DEMO === '1';
const home = process.env.BUREAU_HOME ?? path.join(os.homedir(), demo ? 'Bureau-demo' : 'Bureau');
const port = Number(process.env.BUREAU_PORT ?? 8787);
const host = process.env.BUREAU_HOST ?? '127.0.0.1';
const webDist = path.resolve(import.meta.dirname, '../../web/dist');

function findClaude(): string | null {
  if (process.env.BUREAU_CLAUDE_PATH) return process.env.BUREAU_CLAUDE_PATH;
  try {
    return execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const claudePath = demo ? null : findClaude();
// The office's Claude account. Unset means this Mac's ordinary sign-in; it is never taken from a
// CLAUDE_CONFIG_DIR left in the shell that started the server.
const officeConfigDir = process.env.BUREAU_CLAUDE_CONFIG_DIR?.trim() || null;
const engine = demo ? new DemoEngine() : new ClaudeEngine({ claudePath, configDir: officeConfigDir });
const app = createApp({ home, engine, demo });

// The work list lives in beads. Start it now, and look every minute for changes made from a terminal.
void app.work.ready().then((ok) => {
  if (!ok) return;
  setInterval(() => { void app.work.refresh().catch(() => undefined); }, 60_000).unref();
});
// One backup a day, once the owner has switched them on in Settings.
app.usage.start();
app.drop.start();
// How full each saved conversation is, for the readout. Read in the background; it spends no usage.
void app.turns.readContexts();
  app.backup.start();
// The office's Drive folder can appear after the office starts (Google Drive opens later); lay it out when it does.
setInterval(() => { app.drive.ensure(); }, 10 * 60_000).unref();
const http = createHttp(app, { webDist, port });
const server = createAdaptorServer({ fetch: http.fetch }) as Server;
const sync = attachSync(server, app);

server.listen(port, host, () => {
  const url = `http://localhost:${port}`;
  console.log(`Bureau is running at ${url}`);
  console.log(`  Office folder: ${home}`);
  console.log(`  Engine: ${demo ? 'demo (scripted, no Claude usage)' : `Claude Code${claudePath ? ` at ${claudePath}` : ' (bundled with the SDK; "claude" was not found on PATH)'}`}`);
  console.log(`  Work list: ${app.work.available ? `beads, in ${app.work.dir}` : `off (${app.work.problem})`}`);
  const b = app.backup.status();
  console.log(`  Backups: ${b.hasKey ? (b.problem ? `on, but cannot run (${b.problem})` : `daily, to ${b.folder}`) : 'not switched on (Settings, Backup)'}`);
  if (!demo) console.log(`  Claude account: ${officeConfigDir ? `the one signed in under ${officeConfigDir}` : 'this Mac’s ordinary Claude Code sign-in'} (Settings shows which)`);
  console.log('  Open it on this Mac to begin. Other devices pair with a code from Settings.');
});

if (demo) {
  // Show some life: two members of staff start working shortly after the demo opens.
  setTimeout(() => { void app.turns.enqueue('atlas', { kind: 'system', text: 'Look into Northbeam Ventures’ last twelve investments before Thursday’s call.' }); }, 2500).unref();
}

const shutdown = () => {
  sync.close();
  server.close();
  app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
