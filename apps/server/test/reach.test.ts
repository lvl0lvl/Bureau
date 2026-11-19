import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { DemoEngine } from '../src/engine/demo.ts';
import { createHttp } from '../src/http.ts';
import { installScript } from '../src/mac.ts';
import { readReach } from '../src/reach.ts';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/store.ts';

const NAME = 'office-mac.example.ts.net';
const status = { BackendState: 'Running', Self: { DNSName: `${NAME}.` } };
const serving = (entries: Record<string, string>) => ({ Web: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { Handlers: { '/': { Proxy: v } } }])) });

test('the address is the Tailscale name that Serve points at this office', () => {
  assert.deepEqual(readReach(status, serving({ [`${NAME}:443`]: 'http://127.0.0.1:8787' }), 8787), { address: `https://${NAME}`, tailscale: true, taken: null });
  assert.equal(readReach(status, serving({ [`${NAME}:8443`]: 'http://localhost:8787' }), 8787).address, `https://${NAME}:8443`);
});

test('another app on the default port is named, so the owner knows why devices lost the office', () => {
  const r = readReach(status, serving({ [`${NAME}:443`]: 'http://127.0.0.1:3773' }), 8787);
  assert.equal(r.address, null);
  assert.equal(r.taken, 'http://127.0.0.1:3773');
  // Once the office has a port of its own again, nothing is wrong.
  assert.equal(readReach(status, serving({ [`${NAME}:443`]: 'http://127.0.0.1:3773', [`${NAME}:8443`]: 'http://127.0.0.1:8787' }), 8787).taken, null);
});

test('no Tailscale, or not signed in, means no address', () => {
  assert.deepEqual(readReach(null, null, 8787), { address: null, tailscale: false, taken: null });
  assert.equal(readReach({ ...status, BackendState: 'Stopped' }, serving({}), 8787).tailscale, false);
  assert.equal(readReach(status, null, 8787).address, null);
});

test('the install script carries only a checked address and code', () => {
  const s = installScript(`https://${NAME}`, "ab-cd'; rm -rf ~");
  assert.match(s, new RegExp(`OFFICE='https://${NAME.replace(/\./g, '\\.')}'`));
  assert.match(s, /CODE='ABCDRMRF'/);
  assert.throws(() => installScript("https://x.ts.net'; echo", 'A'));
});

let app: App;
let home: string;
let http: ReturnType<typeof createHttp>;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bureau-reach-'));
  process.env.BUREAU_OWNER = 'Robin Hale';
  process.env.BUREAU_REACH = `https://${NAME}`;
  // A stand-in for a built app.
  const fake = path.join(home, 'Bureau.app', 'Contents', 'MacOS');
  fs.mkdirSync(fake, { recursive: true });
  fs.writeFileSync(path.join(fake, 'Bureau'), 'not really an app');
  process.env.BUREAU_MAC_APP = path.join(home, 'Bureau.app');
  app = createApp({ home, engine: new DemoEngine({ speed: 0 }) });
  http = createHttp(app, { webDist: home });
});

after(() => {
  app.close();
  delete process.env.BUREAU_REACH;
  delete process.env.BUREAU_MAC_APP;
  fs.rmSync(home, { recursive: true, force: true });
});

test('another Mac fetches the installer and the app without being paired', async () => {
  const res = await http.request('/api/mac/install?code=K7QX2MPA');
  assert.equal(res.status, 200);
  const script = await res.text();
  assert.match(script, /CODE='K7QX2MPA'/);
  assert.match(script, /api\/mac\/Bureau\.zip/);
  // The script is valid sh.
  const file = path.join(home, 'install.sh');
  fs.writeFileSync(file, script);
  execFileSync('/bin/sh', ['-n', file]);

  const zip = await http.request('/api/mac/Bureau.zip');
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.equal(String.fromCharCode(bytes[0]!, bytes[1]!), 'PK');
});

test('the reach is for paired devices only', async () => {
  assert.equal((await http.request('/api/reach')).status, 401);
  const cookie = app.auth.cookie(app.auth.pairLocal(), false).split(';')[0]!;
  const r = (await (await http.request('/api/reach', { headers: { cookie } })).json()) as { address: string; macApp: boolean };
  assert.equal(r.address, `https://${NAME}`);
  assert.equal(r.macApp, true);
});

test('a code made by pnpm pair while the office runs pairs the other Mac, with its own name', async () => {
  const other = new Store(path.join(home, 'bureau.db'));
  const { code } = new Auth(other).createCode();
  other.close();
  const res = await http.request('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, label: 'Studio MacBook' }) });
  assert.equal(res.status, 200);
  assert.ok(app.auth.devices().some((d) => d.label === 'Studio MacBook'));
  // Still only once.
  assert.equal((await http.request('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, label: 'again' }) })).status, 403);
});
