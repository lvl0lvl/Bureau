import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import type { EngineInfo, Level, LibraryFile, ReachInfo, SessionInfo, UsageSummary } from '../../../shared/contract.ts';
import { actionClass, compactAt, EFFORTS, PROTOCOL, staffColor, usageGuard } from '../../../shared/contract.ts';
import type { App } from './app.ts';
import { Auth } from './auth.ts';
import { ownerRemoved } from './calendar.ts';
import { installScript, macAppSource, macZip } from './mac.ts';
import { reach } from './reach.ts';
import { leaveInDrop, MAX_FILES_PER_MESSAGE, MAX_UPLOAD_BYTES, NoDriveFolder } from './intake.ts';
import { Scheduler } from './scheduler.ts';
import { starterAuthority } from './hires.ts';
import { systemAppend } from './prompt.ts';
import { ensureStaffHome } from './seed.ts';
import { newId } from './store.ts';
import { weekReport } from './week.ts';

type Env = { Bindings: HttpBindings; Variables: { deviceId: string } };
type C = Context<Env>;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf', '.py': 'text/plain; charset=utf-8',
};

const IMAGE: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic', '.tsv': 'text/tab-separated-values; charset=utf-8', '.fountain': 'text/plain; charset=utf-8', '.json': 'application/json', '.js': 'text/plain; charset=utf-8', '.ts': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8', '.yaml': 'text/plain; charset=utf-8', '.yml': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.xml': 'text/plain; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8' };

const bad = (c: C, message: string, status: 400 | 403 | 404 | 409 | 413 = 400) => c.json({ error: message }, status);

export function isSecure(c: C): boolean {
  return (c.req.header('x-forwarded-proto') ?? '').split(',')[0]?.trim() === 'https';
}

export function createHttp(app: App, opts: { webDist: string; port?: number }) {
  const port = opts.port ?? Number(process.env.BUREAU_PORT ?? 8787);
  const { store, auth, slips, turns, books, push, catalog, hires } = app;
  const settings = () => store.get('settings', 'settings')!;
  const api = new Hono<Env>();

  const local = (c: C) => Auth.isLocal(c.env.incoming.socket.remoteAddress, { host: c.req.header('host'), forwardedFor: c.req.header('x-forwarded-for') });

  // -------------------------------------------------- open to anyone
  api.get('/session', (c) => {
    let device = auth.verify(c.req.header('cookie'));
    if (!device && local(c)) {
      c.header('Set-Cookie', auth.cookie(auth.pairLocal(), false));
      device = { id: 'local' } as any;
    }
    const s = store.get('settings', 'settings')!;
    return c.json({ paired: !!device, ownerName: s.ownerName, hostName: s.hostName, protocol: PROTOCOL } satisfies SessionInfo);
  });

  api.post('/pair', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const value = auth.pair(String(body.code ?? ''), String(body.label ?? ''));
    if (!value) return bad(c, 'That code is not valid any more. Make a new one in Settings on a device that is already paired.', 403);
    c.header('Set-Cookie', auth.cookie(value, isSecure(c)));
    return c.json({ ok: true });
  });

  // The Mac app for the owner's other Macs. Anyone who can reach the office may fetch it; it
  // holds nothing of the office's, and it still has to be paired before it can open anything.
  api.get('/mac/install', async (c) => {
    const r = await reach(port);
    const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? '';
    const office = r.address ?? `${isSecure(c) ? 'https' : 'http'}://${host}`;
    if (!macAppSource()) return c.text('echo "The office has no copy of the Mac app to hand out. On the office Mac, run: pnpm mac:build"; exit 1\n', 404);
    try {
      return c.text(installScript(office, c.req.query('code') ?? ''), 200, { 'Cache-Control': 'no-store' });
    } catch {
      return c.text('echo "This office has no address another Mac can use."; exit 1\n', 400);
    }
  });
  api.get('/mac/Bureau.zip', async (c) => {
    const zip = macZip(path.join(app.home, 'cache'));
    if (!zip) return c.text('The office has no copy of the Mac app to hand out.', 404);
    const file = await zip;
    const size = fs.statSync(file).size;
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(size), 'Content-Disposition': 'attachment; filename="Bureau.zip"', 'Cache-Control': 'no-store' },
    });
  });

  // ------------------------------------------- everything else: paired only
  api.use('*', async (c, next) => {
    const device = auth.verify(c.req.header('cookie'));
    if (!device) return c.json({ error: 'This device is not paired.' }, 401);
    // Changes must come from our own pages.
    if (c.req.method !== 'GET') {
      const origin = c.req.header('origin');
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* malformed */ }
        if (host !== c.req.header('host')) return c.json({ error: 'Cross-site request refused.' }, 403);
      }
    }
    c.set('deviceId', device.id);
    await next();
  });

  api.get('/snapshot', (c) => c.json(store.snapshot(turns.allLive())));

  // ---------------------------------------------------------- threads
  api.get('/threads/:staffId', (c) => {
    const before = c.req.query('before');
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 60)));
    return c.json(store.thread(c.req.param('staffId'), before ? Number(before) : null, limit));
  });

  api.post('/threads/:staffId/messages', async (c) => {
    const staff = store.get('staff', c.req.param('staffId'));
    if (!staff || staff.retired) return bad(c, 'No such member of staff.', 404);
    const body = await c.req.json().catch(() => ({}));
    const text = String(body.text ?? '').trim();
    const wanted = Array.isArray(body.files) ? body.files.filter((f: unknown) => typeof f === 'string') as string[] : [];
    if (!text && !wanted.length) return bad(c, 'Write something first.');
    if (text.length > 20_000) return bad(c, 'That is too long for one message.');
    if (wanted.length > MAX_FILES_PER_MESSAGE) return bad(c, `No more than ${MAX_FILES_PER_MESSAGE} files with one message.`);
    // Attached files move into this person's folder now, so they are there when the turn starts.
    const tz = settings().timezone;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(Date.now());
    const files = wanted.length ? app.uploads.take(wanted, path.join(app.staffRoot, staff.id), day) : [];
    if (wanted.length && !files.length) return bad(c, 'The attached files could not be found. Attach them again.');
    // Sent from the hiring desk: tell the chief of staff so, and which draft is open, if any.
    let hint: string | undefined;
    if (staff.isChief && body.hire !== undefined) {
      const draft = typeof body.hire === 'string' ? store.get('hire', body.hire) : undefined;
      hint = draft && draft.status === 'draft'
        ? `From the hiring desk. Open draft: ${draft.id}, “${draft.name}, ${draft.role}”. ${settings().ownerName} may have edited it since you saved it.`
        : 'From the hiring desk. No draft yet.';
    }
    const row = store.appendRow(staff.id, { type: 'message', from: 'owner', text, ...(files.length ? { files: files.map((f) => ({ name: f.name, bytes: f.bytes })) } : {}) });
    void turns.enqueue(staff.id, { kind: 'owner', text, hint, ...(files.length ? { files } : {}) });
    return c.json({ row });
  });

  // A file to go with the next message. The body is the file itself; its name is in the query.
  api.put('/uploads', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_UPLOAD_BYTES) return bad(c, 'That file is larger than 25 MB. Put it in Drop here in the office Drive folder instead.', 413);
    const data = new Uint8Array(await c.req.arrayBuffer());
    try {
      return c.json(app.uploads.save(c.req.query('name') ?? 'file', data));
    } catch (e) {
      return bad(c, (e as Error).message, 413);
    }
  });

  // A photo taken in the app. It goes in "Drop here" in the office Drive folder, where the chief
  // of staff picks it up like anything else left there. `watched` says whether that will happen.
  api.put('/drop', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (declared > MAX_UPLOAD_BYTES) return bad(c, 'That file is larger than 25 MB.', 413);
    const data = new Uint8Array(await c.req.arrayBuffer());
    try {
      // An office that has not looked in the folder yet looks now, so the photo counts as new.
      if (data.byteLength > 0 && data.byteLength <= MAX_UPLOAD_BYTES) app.drop.settle();
      const left = leaveInDrop(app.drive, c.req.query('name') ?? 'file', data);
      const watched = settings().watchDrop !== false && store.list('staff').some((s) => s.isChief && !s.retired);
      return c.json({ name: left.name, bytes: left.bytes, watched });
    } catch (e) {
      return bad(c, (e as Error).message, e instanceof NoDriveFolder ? 409 : 413);
    }
  });

  api.post('/threads/:staffId/stop', (c) => { turns.stop(c.req.param('staffId')); return c.json({ ok: true }); });

  api.post('/threads/:staffId/new', (c) => {
    const id = c.req.param('staffId');
    if (!store.get('staff', id)) return bad(c, 'No such member of staff.', 404);
    if (turns.isBusy(id)) return bad(c, 'Wait until the current work has finished, or stop it first.', 409);
    turns.newConversation(id);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ slips
  const slipResult = (c: C, r: ReturnType<typeof slips.sign>) => ('error' in r ? bad(c, r.error, 409) : c.json({ slip: r }));
  api.post('/slips/:id/sign', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const items = Array.isArray(body.items) ? body.items.filter((i: unknown): i is number => typeof i === 'number') : undefined;
    return slipResult(c, slips.sign(c.req.param('id'), typeof body.text === 'string' ? body.text : undefined, items));
  });
  api.post('/slips/:id/undo', (c) => slipResult(c, slips.undo(c.req.param('id'))));
  api.post('/slips/:id/decline', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return slipResult(c, slips.decline(c.req.param('id'), typeof body.reason === 'string' ? body.reason : undefined));
  });
  api.post('/slips/:id/answer', async (c) => {
    const answer = String((await c.req.json().catch(() => ({}))).answer ?? '').trim();
    if (!answer) return bad(c, 'Choose an answer.');
    return slipResult(c, slips.answer(c.req.param('id'), answer));
  });

  // ------------------------------------------------------------ staff
  const staffFields = (body: any) => {
    const out: Record<string, unknown> = {};
    for (const k of ['name', 'role', 'about', 'instructions'] as const) if (typeof body[k] === 'string') out[k] = body[k].trim().slice(0, k === 'instructions' ? 8000 : k === 'about' ? 600 : 60);
    if (typeof body.letter === 'string' && body.letter.trim()) out.letter = body.letter.trim()[0]!.toUpperCase();
    if (body.model === null || typeof body.model === 'string') out.model = body.model ? String(body.model).trim() : null;
    if (body.color === null || body.color === '') out.color = null;
    else if (staffColor(body.color)) out.color = body.color;
    if (body.effort === null || body.effort === '') out.effort = null;
    else if (EFFORTS.includes(body.effort)) out.effort = body.effort;
    if (body.configDir === null || typeof body.configDir === 'string') out.configDir = body.configDir ? String(body.configDir).trim() : null;
    return out;
  };

  api.post('/staff', async (c) => {
    const f = staffFields(await c.req.json().catch(() => ({})));
    if (!f.name || !f.role) return bad(c, 'A new member of staff needs a name and a role.');
    // Everyone starts by looking and drafting. Authority is earned.
    const authority: Record<string, Level> = starterAuthority();
    const staff = store.put('staff', {
      id: newId('staff'), name: f.name as string, letter: (f.letter as string) ?? (f.name as string)[0]!.toUpperCase(), role: f.role as string,
      about: (f.about as string) ?? '', instructions: (f.instructions as string) ?? '', skills: [], isChief: false, model: (f.model as string | null) ?? null,
      configDir: (f.configDir as string | null) ?? null, authority, record: { asWritten: 0, edited: 0, declined: 0 },
      order: store.list('staff').length, hiredAt: Date.now(), retired: false, unread: 0, lastLine: null,
    });
    ensureStaffHome(app.staffRoot, staff);
    return c.json({ staff });
  });

  api.put('/staff/:id', async (c) => {
    const f = staffFields(await c.req.json().catch(() => ({})));
    // Claude Code takes an alias (opus, sonnet) or a full model id, never a display name such as "Opus 5.5".
    if (typeof f.model === 'string' && !/^[A-Za-z0-9][A-Za-z0-9._\-\[\]]*$/.test(f.model)) return bad(c, `“${f.model}” is not a model name Claude Code accepts. Choose one from the list.`);
    const before = store.get('staff', c.req.param('id'));
    const staff = store.update('staff', c.req.param('id'), (s) => { Object.assign(s, f); });
    // A conversation is stored with the Claude account that held it. Moving someone to another
    // account starts a fresh conversation; their notes, files, duties and authority are unchanged.
    if (before && staff && before.configDir !== staff.configDir) store.putPrivate('_staffx', { id: staff.id, sessionId: null });
    return staff ? c.json({ staff }) : bad(c, 'No such member of staff.', 404);
  });

  // What this person is told at the start of every piece of work: the office, their authority, their profile.
  api.get('/staff/:id/briefing', (c) => {
    const staff = store.get('staff', c.req.param('id'));
    if (!staff) return bad(c, 'No such member of staff.', 404);
    const text = systemAppend(staff, store.list('staff'), settings(), { home: path.join(app.staffRoot, staff.id), books: books.dir, work: app.work.available, drive: app.drive.briefing(settings().ownerName) });
    return c.json({ text, folder: path.join(app.staffRoot, staff.id) });
  });

  api.post('/staff/:id/skills', async (c) => {
    const ref = String((await c.req.json().catch(() => ({}))).ref ?? '');
    try {
      const skill = app.skills.install(c.req.param('id'), ref);
      return c.json({ skill, staff: store.get('staff', c.req.param('id')) });
    } catch (e) {
      return bad(c, (e as Error).message);
    }
  });

  api.delete('/staff/:id/skills/:skillId', (c) => {
    if (!app.skills.remove(c.req.param('id'), c.req.param('skillId'))) return bad(c, 'That skill is not installed.', 404);
    return c.json({ staff: store.get('staff', c.req.param('id')) });
  });

  // --------------------------------------------------- catalog & hiring
  api.get('/catalog', (c) => {
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 60)));
    return c.json(catalog.search(c.req.query('q') ?? '', { limit, sourceId: c.req.query('source') || undefined }));
  });
  api.get('/catalog/skill', (c) => {
    const d = catalog.detail(c.req.query('id') ?? '');
    return d ? c.json(d) : bad(c, 'That skill is not in the catalog.', 404);
  });
  // Fetching happens only here, because the owner pressed the button.
  api.post('/catalog/refresh', async (c) => {
    const source = (await c.req.json().catch(() => ({}))).source;
    try {
      if (typeof source === 'string') await catalog.refresh(source);
      else await catalog.refreshAll();
      return c.json({ sources: catalog.sources() });
    } catch (e) {
      return bad(c, (e as Error).message);
    }
  });
  api.post('/catalog/sources', async (c) => {
    try {
      catalog.addSource(String((await c.req.json().catch(() => ({}))).repo ?? ''));
      return c.json({ sources: catalog.sources() });
    } catch (e) {
      return bad(c, (e as Error).message);
    }
  });
  api.delete('/catalog/sources/:id', (c) => { catalog.removeSource(c.req.param('id')); return c.json({ sources: catalog.sources() }); });

  // ---------------------------------------------------------- work list
  const workResult = async (c: C, fn: () => Promise<unknown>) => {
    try { return c.json({ item: await fn() }); } catch (e) { return bad(c, (e as Error).message); }
  };
  api.get('/work', async (c) => {
    await app.work.ready();
    return c.json({ available: app.work.available, problem: app.work.problem, folder: app.work.dir, items: app.work.list() });
  });
  // Pick up changes made with bd in a terminal.
  api.post('/work/sync', async (c) => {
    try { await app.work.refresh(); } catch (e) { return bad(c, (e as Error).message); }
    return c.json({ available: app.work.available, items: app.work.list() });
  });
  api.post('/work', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const staffId = typeof b.staffId === 'string' && b.staffId ? b.staffId : null;
    if (staffId && !store.get('staff', staffId)) return bad(c, 'No such member of staff.', 404);
    return workResult(c, () => app.work.add('owner', {
      title: String(b.title ?? ''), detail: typeof b.detail === 'string' ? b.detail : '', staffId,
      after: Array.isArray(b.after) ? b.after.map(String) : [], start: b.start !== false,
    }));
  });
  api.post('/work/:id/close', async (c) => workResult(c, async () => app.work.close('owner', c.req.param('id'), String((await c.req.json().catch(() => ({}))).result ?? ''))));
  api.post('/work/:id/reopen', (c) => workResult(c, () => app.work.reopen('owner', c.req.param('id'))));
  api.post('/work/:id/note', async (c) => workResult(c, async () => app.work.note('owner', c.req.param('id'), String((await c.req.json().catch(() => ({}))).text ?? ''))));
  api.post('/work/:id/assign', async (c) => workResult(c, async () => {
    const staffId = (await c.req.json().catch(() => ({}))).staffId;
    return app.work.assign('owner', c.req.param('id'), typeof staffId === 'string' && staffId ? staffId : null);
  }));

  api.put('/hires/:id', async (c) => {
    const hire = hires.edit(c.req.param('id'), await c.req.json().catch(() => ({})));
    return hire ? c.json({ hire }) : bad(c, 'That draft is no longer open.', 409);
  });
  api.post('/hires/:id/sign', async (c) => {
    // Sign what is on the screen: any last edits arrive with the signature.
    const body = await c.req.json().catch(() => ({}));
    if (body && Object.keys(body).length) hires.edit(c.req.param('id'), body);
    const result = hires.sign(c.req.param('id'));
    return 'error' in result ? bad(c, result.error, 409) : c.json(result);
  });
  api.delete('/hires/:id', (c) => {
    const hire = hires.drop(c.req.param('id'));
    return hire ? c.json({ hire }) : bad(c, 'That draft is no longer open.', 409);
  });

  api.delete('/staff/:id', (c) => {
    const id = c.req.param('id');
    const cur = store.get('staff', id);
    if (!cur) return bad(c, 'No such member of staff.', 404);
    if (cur.isChief) return bad(c, 'The chief of staff cannot be retired.', 409);
    turns.stop(id);
    const staff = store.update('staff', id, (s) => { s.retired = true; });
    return c.json({ staff });
  });

  api.put('/staff/:id/authority', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const def = actionClass(String(body.classId));
    const level = Number(body.level);
    if (!def || ![0, 1, 2, 3, 4].includes(level)) return bad(c, 'Unknown kind of work or level.');
    if (def.locked) return bad(c, def.lockedNote ?? 'That cannot be changed.', 409);
    const cur = store.get('staff', c.req.param('id'));
    if (!cur) return bad(c, 'No such member of staff.', 404);
    if (def.chiefOnly && !cur.isChief && level > 0) return bad(c, 'Only the chief of staff checks other people’s work.', 409);
    const staff = store.update('staff', cur.id, (s) => { s.authority = { ...s.authority, [def.id]: level as Level }; });
    return c.json({ staff });
  });

  api.post('/staff/:id/seen', (c) => {
    const cur = store.get('staff', c.req.param('id'));
    if (cur && cur.unread) store.update('staff', cur.id, (s) => { s.unread = 0; });
    return c.json({ ok: true });
  });

  // ----------------------------------------------------------- duties
  const dutyFields = (body: any) => {
    const out: Record<string, unknown> = {};
    if (typeof body.title === 'string') out.title = body.title.trim().slice(0, 80);
    if (typeof body.cadence === 'string') out.cadence = body.cadence.trim().slice(0, 80);
    if (typeof body.prompt === 'string') out.prompt = body.prompt.trim().slice(0, 4000);
    if (typeof body.enabled === 'boolean') out.enabled = body.enabled;
    if (body.cron === null || body.cron === '') out.cron = null;
    else if (typeof body.cron === 'string') out.cron = body.cron.trim();
    return out;
  };

  api.post('/duties', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const f = dutyFields(body);
    if (!store.get('staff', String(body.staffId))) return bad(c, 'No such member of staff.', 404);
    if (!f.title || !f.prompt) return bad(c, 'A duty needs a title and instructions.');
    if (f.cron && !Scheduler.valid(f.cron as string)) return bad(c, 'That schedule is not valid. Use five fields: minute, hour, day of month, month, day of week.');
    const duty = store.put('duty', {
      id: newId('duty'), staffId: String(body.staffId), title: f.title as string, cadence: (f.cadence as string) ?? '', cron: (f.cron as string | null) ?? null,
      prompt: f.prompt as string, enabled: (f.enabled as boolean) ?? false, lastDoneAt: null, nextDueAt: null, note: null, attention: false,
    });
    return c.json({ duty });
  });

  api.put('/duties/:id', async (c) => {
    const f = dutyFields(await c.req.json().catch(() => ({})));
    if (f.cron && !Scheduler.valid(f.cron as string)) return bad(c, 'That schedule is not valid. Use five fields: minute, hour, day of month, month, day of week.');
    const duty = store.update('duty', c.req.param('id'), (d) => { Object.assign(d, f); });
    return duty ? c.json({ duty }) : bad(c, 'No such duty.', 404);
  });

  api.delete('/duties/:id', (c) => { store.del('duty', c.req.param('id')); return c.json({ ok: true }); });

  api.post('/duties/:id/run', (c) => {
    const d = store.get('duty', c.req.param('id'));
    if (!d) return bad(c, 'No such duty.', 404);
    // The owner asked for this run, so the usage hold does not apply to it.
    if (d.held) store.update('duty', d.id, (x) => { x.held = null; });
    void turns.enqueue(d.staffId, { kind: 'duty', dutyId: d.id, title: d.title, prompt: d.prompt });
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------- due
  const isDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  api.post('/due', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (!isDate(b.date) || typeof b.title !== 'string' || !b.title.trim()) return bad(c, 'An item needs a date and a title.');
    const item = store.put('due', { id: newId('due'), date: b.date, title: b.title.trim().slice(0, 120), note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 160) : null, attention: !!b.attention, staffId: typeof b.staffId === 'string' ? b.staffId : null, done: false });
    return c.json({ due: item });
  });
  api.put('/due/:id', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const item = store.update('due', c.req.param('id'), (d) => {
      if (isDate(b.date)) d.date = b.date;
      if (typeof b.title === 'string' && b.title.trim()) d.title = b.title.trim().slice(0, 120);
      if (b.note === null || typeof b.note === 'string') d.note = b.note ? String(b.note).trim().slice(0, 160) : null;
      if (typeof b.attention === 'boolean') d.attention = b.attention;
      if (typeof b.done === 'boolean') d.done = b.done;
    });
    return item ? c.json({ due: item }) : bad(c, 'No such item.', 404);
  });
  api.delete('/due/:id', (c) => {
    // An appointment the owner takes off the office calendar is not copied back from Google Calendar.
    ownerRemoved(store, store.get('due', c.req.param('id')));
    store.del('due', c.req.param('id'));
    return c.json({ ok: true });
  });
  // When scheduled duties run, for the calendar.
  api.get('/duties/runs', (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (!isDate(from) || !isDate(to)) return bad(c, 'Give a first and last date as YYYY-MM-DD.');
    return c.json({ runs: app.scheduler.runsBetween(from as string, to as string) });
  });

  // ------------------------------------------------------------ books
  api.get('/books/tree', (c) => c.json({ entries: books.tree() }));
  api.get('/books/file', (c) => {
    try { return c.json(books.file(String(c.req.query('path') ?? ''))); } catch (e) { return bad(c, (e as Error).message, 404); }
  });
  api.get('/books/history', (c) => c.json({ commits: books.history() }));
  api.post('/books/revert', async (c) => {
    const r = books.revert(String((await c.req.json().catch(() => ({}))).sha ?? ''), settings().ownerName);
    return r.ok ? c.json({ ok: true }) : bad(c, r.error ?? 'Could not undo that change.', 409);
  });

  // ---------------------------------------------------------- library
  api.get('/library', (c) => {
    const files: LibraryFile[] = [];
    for (const s of store.list('staff')) {
      const root = path.join(app.staffRoot, s.id, 'library');
      const walk = (dir: string) => {
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else { const st = fs.statSync(full); files.push({ staffId: s.id, path: path.relative(root, full), size: st.size, modifiedAt: st.mtimeMs }); }
        }
      };
      walk(root);
    }
    return c.json({ files: files.sort((a, b) => b.modifiedAt - a.modifiedAt) });
  });

  api.get('/library/file', (c) => {
    const staffId = String(c.req.query('staff') ?? '');
    if (!store.get('staff', staffId)) return bad(c, 'No such member of staff.', 404);
    const root = path.join(app.staffRoot, staffId, 'library');
    const file = path.resolve(root, String(c.req.query('path') ?? ''));
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return bad(c, 'No such file.', 404);
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const inline = /^(text\/|image\/|application\/pdf|application\/json)/.test(type) && type !== 'text/html; charset=utf-8';
    return new Response(fs.readFileSync(file), {
      headers: {
        'Content-Type': type === 'text/html; charset=utf-8' ? 'text/plain; charset=utf-8' : type,
        'Content-Disposition': `${inline && !c.req.query('download') ? 'inline' : 'attachment'}; filename="${path.basename(file).replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  });

  // -------------------------------------------------------- artifacts
  // The library again, as pieces of work with their versions, and what the owner can do with them.
  const artifactResult = async (c: C, fn: () => unknown) => {
    try { return c.json((await fn()) ?? { ok: true }); } catch (e) { return bad(c, (e as Error).message); }
  };
  api.get('/artifacts', (c) => c.json({ artifacts: app.artifacts.list(c.req.query('staff') || undefined) }));
  api.get('/artifacts/file', (c) => {
    const file = app.artifacts.file(String(c.req.query('staff') ?? ''), String(c.req.query('path') ?? ''));
    if (!file) return bad(c, 'No such file.', 404);
    const type = MIME[path.extname(file).toLowerCase()] ?? IMAGE[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const html = type.startsWith('text/html');
    const pdf = type === 'application/pdf';
    const inline = !c.req.query('download') && /^(text\/|image\/|application\/pdf|application\/json)/.test(type);
    return new Response(fs.readFileSync(file), {
      headers: {
        // A page is handed over as text: the app shows it in a sealed frame of its own.
        'Content-Type': html ? 'text/plain; charset=utf-8' : type,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        // The browser's own PDF viewer will not run in a sandbox.
        'Content-Security-Policy': pdf ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'self'" : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      },
    });
  });
  const artifactBody = async (c: C) => { const b = await c.req.json().catch(() => ({})); return { staff: String(b.staff ?? ''), id: String(b.id ?? ''), ...b }; };
  api.post('/artifacts/retire', async (c) => { const b = await artifactBody(c); return artifactResult(c, () => ({ artifact: app.artifacts.retire(b.staff, b.id, b.retired !== false) })); });
  api.post('/artifacts/drive', async (c) => { const b = await artifactBody(c); return artifactResult(c, () => app.artifacts.toDrive(b.staff, b.id, typeof b.version === 'string' ? b.version : undefined)); });
  api.post('/artifacts/delete', async (c) => { const b = await artifactBody(c); return artifactResult(c, () => app.artifacts.remove(b.staff, b.id)); });
  // Notes on a passage, the owner's own edits, and handing the notes back to the writer.
  api.get('/artifacts/notes', (c) => c.json({ notes: app.artifacts.notes(String(c.req.query('staff') ?? ''), String(c.req.query('id') ?? '')) }));
  api.post('/artifacts/notes', async (c) => {
    const b = await artifactBody(c);
    return artifactResult(c, () => ({ note: app.artifacts.addNote(b.staff, b.id, { path: String(b.path ?? ''), quote: String(b.quote ?? ''), before: String(b.before ?? ''), text: String(b.text ?? '') }) }));
  });
  api.post('/artifacts/notes/:note/change', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return artifactResult(c, () => ({ note: app.artifacts.updateNote(c.req.param('note'), { text: typeof b.text === 'string' ? b.text : undefined, done: typeof b.done === 'boolean' ? b.done : undefined }) }));
  });
  api.delete('/artifacts/notes/:note', (c) => artifactResult(c, () => { app.artifacts.removeNote(c.req.param('note')); return { ok: true }; }));
  api.post('/artifacts/edit', async (c) => {
    const b = await artifactBody(c);
    if (typeof b.text !== 'string' || typeof b.base !== 'string') return bad(c, 'Send the text and the version it was edited from.');
    return artifactResult(c, () => app.artifacts.saveEdit(b.staff, b.id, b.base, b.text));
  });
  api.post('/artifacts/notes/send', async (c) => {
    const b = await artifactBody(c);
    const staff = store.get('staff', b.staff);
    if (!staff || staff.retired) return bad(c, 'No such member of staff.', 404);
    return artifactResult(c, () => {
      const m = app.artifacts.composeNotes(staff.id, b.id);
      // As if the owner had written it in the conversation, so it reads there and starts a turn.
      const row = store.appendRow(staff.id, { type: 'message', from: 'owner', text: m.text });
      void turns.enqueue(staff.id, { kind: 'owner', text: m.text, hint: m.hint });
      return { row, notes: m.notes };
    });
  });

  // --------------------------------------------------------- settings
  api.put('/settings', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const compactBefore = compactAt(store.get('settings', 'settings'));
    const settings = store.update('settings', 'settings', (s) => {
      if (typeof b.ownerName === 'string' && b.ownerName.trim()) s.ownerName = b.ownerName.trim().slice(0, 40);
      if (typeof b.ownerAbout === 'string') s.ownerAbout = b.ownerAbout.trim().slice(0, 1200);
      if (typeof b.ownerInitials === 'string' && b.ownerInitials.trim()) s.ownerInitials = b.ownerInitials.trim().slice(0, 3).toUpperCase();
      if (typeof b.signatureText === 'string' && b.signatureText.trim()) s.signatureText = b.signatureText.trim().slice(0, 40);
      if (b.signature === null) s.signature = null;
      else if (b.signature && Array.isArray(b.signature.paths)) {
        const paths = b.signature.paths.filter((p: unknown) => typeof p === 'string' && /^[MLCQTSZmlcqtsz0-9\s.,-]+$/.test(p as string)).slice(0, 60);
        if (paths.length && paths.join('').length < 60_000) s.signature = { paths, width: 600, height: 160 };
      }
      if (Number.isFinite(b.undoSeconds)) s.undoSeconds = Math.min(60, Math.max(0, Math.round(b.undoSeconds)));
      if (typeof b.checkSlips === 'boolean') s.checkSlips = b.checkSlips;
      if (b.usageGuard && typeof b.usageGuard === 'object') s.usageGuard = usageGuard({ usageGuard: { ...usageGuard(s), ...b.usageGuard } });
      if (Number.isFinite(b.compactAt)) s.compactAt = compactAt({ compactAt: b.compactAt });
      if (typeof b.watchDrop === 'boolean') s.watchDrop = b.watchDrop;
      if (typeof b.timezone === 'string') {
        try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); s.timezone = b.timezone; } catch { /* keep */ }
      }
    });
    // A new window moves where every conversation compacts, so measure them again.
    if (compactAt(settings) !== compactBefore) void turns.readContexts({ all: true });
    return c.json({ settings });
  });

  // ------------------------------------------- Drive folder and backups
  api.get('/drive', (c) => { app.drive.ensure(); return c.json({ ...app.drive.status(), drop: app.drop.folders() }); });
  // Leave a folder in Drop here alone, or hand it over again.
  api.post('/drop/park', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    try {
      app.drop.park(String(b.folder ?? ''), b.on !== false, settings().ownerName);
    } catch (e) {
      return bad(c, (e as Error).message);
    }
    return c.json({ drive: { ...app.drive.status(), drop: app.drop.folders() } });
  });
  api.put('/drive', async (c) => {
    const folder = (await c.req.json().catch(() => ({}))).folder;
    try {
      app.drive.choose(typeof folder === 'string' && folder.trim() ? folder : null);
    } catch (e) {
      return bad(c, (e as Error).message);
    }
    return c.json({ drive: app.drive.status(), backup: app.backup.status(), settings: settings() });
  });

  // How much of the Claude plan is used. ?fresh=1 reads it from Claude again, at most once a minute.
  api.get('/usage/plan', async (c) => c.json(c.req.query('fresh') ? await app.usage.fresh(0) : app.usage.status()));

  api.get('/backup', (c) => c.json(app.backup.status()));
  // The recovery key is in this one answer and nowhere else: the office keeps only the half that locks.
  api.post('/backup/key', async (c) => {
    const replace = (await c.req.json().catch(() => ({}))).replace === true;
    try {
      const recoveryKey = app.backup.createKey(replace);
      c.header('Cache-Control', 'no-store');
      return c.json({ recoveryKey, status: app.backup.status() });
    } catch (e) {
      return bad(c, (e as Error).message, 409);
    }
  });
  api.post('/backup/run', async (c) => {
    try { await app.backup.run(); } catch (e) { return c.json({ error: (e as Error).message, status: app.backup.status() }, 409); }
    return c.json({ status: app.backup.status() });
  });

  api.get('/devices', (c) => {
    // One-request sessions from this Mac pile up otherwise; the one asking and any that get notifications stay.
    auth.pruneLocal((id) => id === c.get('deviceId') || push.hasDevice(id));
    return c.json({ devices: auth.devices(c.get('deviceId')) });
  });
  api.post('/devices/code', (c) => c.json(auth.createCode()));
  // How other devices reach this office, and whether a Mac app can be handed out.
  api.get('/reach', async (c) => c.json({ ...(await reach(port, c.req.query('fresh') !== undefined)), macApp: !!macAppSource() } satisfies ReachInfo));
  api.delete('/devices/:id', (c) => { push.forgetDevice(c.req.param('id')); auth.revoke(c.req.param('id')); return c.json({ ok: true }); });

  // ---------------------------------------------------- notifications
  api.get('/push', (c) => c.json({ publicKey: push.publicKey(), ...push.subscriptionCount() }));
  api.post('/push/web', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    const origin = c.req.header('origin') ?? `${isSecure(c) ? 'https' : 'http'}://${c.req.header('host')}`;
    if (!/^https:/.test(origin)) return bad(c, 'Notifications need the secure address. Open Bureau through its https address and try again.', 409);
    return push.subscribeWeb(c.get('deviceId'), b.subscription, origin) ? c.json({ ok: true }) : bad(c, 'That subscription is not usable.');
  });
  api.delete('/push/web', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (typeof b.endpoint === 'string') push.unsubscribeWeb(b.endpoint);
    return c.json({ ok: true });
  });
  api.post('/push/apns', async (c) => {
    const b = await c.req.json().catch(() => ({}));
    return push.subscribeApns(c.get('deviceId'), String(b.token ?? ''), !!b.sandbox) ? c.json({ ok: true, configured: !!push.apnsConfig() }) : bad(c, 'That is not a device token.');
  });
  api.post('/push/test', async (c) => {
    await push.notify({ title: 'Bureau', body: 'Notifications are working on this device.', url: '/', tag: 'test' });
    return c.json({ ok: true, ...push.subscriptionCount() });
  });

  api.get('/week', (c) => c.json(weekReport(store)));

  api.get('/usage', (c) => {
    const since = Date.now() - 7 * 86_400_000;
    const out: UsageSummary = { turns: {}, costUsd: 0 };
    for (const u of store.listPrivate<{ staffId: string; at: number; costUsd: number }>('_usage')) {
      if (u.at < since) continue;
      out.turns[u.staffId] = (out.turns[u.staffId] ?? 0) + 1;
      out.costUsd += u.costUsd ?? 0;
    }
    return c.json(out);
  });

  // Which Claude account staff run on and which apps are connected to it. Asking costs no usage
  // but does start Claude Code, so the answer is kept for a few minutes.
  const engineInfo = new Map<string, Promise<EngineInfo>>();
  api.get('/engine', async (c) => {
    const staff = store.get('staff', c.req.query('staff') ?? '') ?? store.list('staff').find((s) => s.isChief) ?? store.list('staff')[0];
    const configDir = staff?.configDir ?? null;
    const key = configDir ?? '';
    const cached = engineInfo.get(key);
    if (cached && !c.req.query('fresh')) {
      const v = await cached;
      if (Date.now() - v.checkedAt < 5 * 60_000 && !v.error) return c.json(v);
    }
    const next = app.engine.info({ configDir, cwd: staff ? path.join(app.staffRoot, staff.id) : app.home });
    engineInfo.set(key, next);
    return c.json(await next);
  });

  api.all('*', (c) => bad(c, 'Not found.', 404));

  // ------------------------------------------------------ the web app
  const root = new Hono<Env>();
  root.route('/api', api);
  root.get('*', (c) => {
    const dist = opts.webDist;
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    let file = path.resolve(dist, `.${urlPath}`);
    if (path.relative(dist, file).startsWith('..')) return c.text('Not found', 404);
    const exists = fs.existsSync(file) && fs.statSync(file).isFile();
    if (!exists) {
      if (path.extname(urlPath)) return c.text('Not found', 404);
      file = path.join(dist, 'index.html');
      if (!fs.existsSync(file)) return c.text('The web app has not been built yet. Run "pnpm build" in the project folder, or use "pnpm dev".', 503);
    }
    const ext = path.extname(file).toLowerCase();
    const hashed = /\/assets\//.test(file);
    return new Response(fs.readFileSync(file), {
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  return root;
}
