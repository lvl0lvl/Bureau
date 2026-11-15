import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Change, ClientMsg, Row, ServerMsg } from '../../../shared/contract.ts';
import { PROTOCOL } from '../../../shared/contract.ts';
import type { App } from './app.ts';

/**
 * The live connection to each client.
 *
 * A client says which revision it has; it gets what changed since, then every change as it
 * happens. Transcript rows and streamed text go only to clients that have that thread open.
 */

interface Conn {
  ws: WebSocket;
  thread: string | null;
  ready: boolean;
}

const THREAD_WINDOW = 60;

export function attachSync(server: Server, app: App) {
  const { store, auth, turns } = app;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const conns = new Set<Conn>();

  const send = (conn: Conn, msg: ServerMsg) => {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  };

  /** Slips referenced by thread rows may be older than the snapshot window; send them along. */
  const slipsFor = (rows: Row[]): Change[] => {
    const out: Change[] = [];
    for (const r of rows) {
      if (r.body.type !== 'slip') continue;
      const slip = store.get('slip', r.body.slipId);
      if (slip) out.push({ k: 'slip', v: slip });
    }
    return out;
  };

  const sendThread = (conn: Conn, staffId: string) => {
    const page = store.thread(staffId, null, THREAD_WINDOW);
    const extra = slipsFor(page.rows);
    if (extra.length) send(conn, { t: 'delta', rev: store.rev, changes: extra });
    send(conn, { t: 'thread', staffId, rows: page.rows, hasMore: page.hasMore });
  };

  store.on((e) => {
    if (e.type === 'stream') {
      for (const c of conns) if (c.ready && c.thread === e.staffId) send(c, { t: 'stream', rowId: e.rowId, staffId: e.staffId, add: e.add });
      return;
    }
    for (const c of conns) {
      if (!c.ready) continue;
      const changes = e.changes.filter((ch) => ch.k !== 'row' || ch.v.staffId === c.thread);
      // A slip row may point at a slip this client has not been sent.
      const rows = changes.filter((ch): ch is Extract<Change, { k: 'row' }> => ch.k === 'row').map((ch) => ch.v);
      const all = [...slipsFor(rows), ...changes];
      if (all.length) send(c, { t: 'delta', rev: e.rev, changes: all });
    }
  });

  app.onLive((live) => {
    for (const c of conns) if (c.ready) send(c, { t: 'live', v: live });
  });

  wss.on('connection', (ws) => {
    const conn: Conn = { ws, thread: null, ready: false };
    conns.add(conn);
    ws.on('close', () => conns.delete(conn));
    ws.on('error', () => conns.delete(conn));
    ws.on('message', (data) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.t === 'ping') return send(conn, { t: 'pong', n: msg.n, serverTime: Date.now() });
      if (msg.t === 'hello') {
        conn.thread = msg.thread && store.get('staff', msg.thread) ? msg.thread : null;
        const changes = msg.protocol === PROTOCOL && msg.cursor !== null ? store.changesSince(msg.cursor, conn.thread) : null;
        if (changes === null) {
          send(conn, { t: 'snapshot', snapshot: store.snapshot(turns.allLive()) });
          if (conn.thread) sendThread(conn, conn.thread);
        } else {
          const rows = changes.filter((ch): ch is Extract<Change, { k: 'row' }> => ch.k === 'row').map((ch) => ch.v);
          send(conn, { t: 'delta', rev: store.rev, changes: [...slipsFor(rows), ...changes] });
          for (const live of turns.allLive()) send(conn, { t: 'live', v: live });
        }
        conn.ready = true;
        return;
      }
      if (!conn.ready) return;
      if (msg.t === 'open') {
        if (!store.get('staff', msg.staffId)) return;
        conn.thread = msg.staffId;
        sendThread(conn, msg.staffId);
      } else if (msg.t === 'close') {
        conn.thread = null;
      } else if (msg.t === 'seen') {
        const s = store.get('staff', msg.staffId);
        if (s && s.unread) store.update('staff', s.id, (x) => { x.unread = 0; });
      }
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/api/sync') return socket.destroy();
    // A browser on this Mac is paired by its first HTTP request, so the cookie is there by now.
    const device = auth.verify(req.headers.cookie);
    const origin = req.headers.origin;
    let originHost = '';
    try { originHost = origin ? new URL(origin).host : ''; } catch { /* malformed */ }
    if (!device || (origin && originHost !== req.headers.host)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return {
    count: () => conns.size,
    close: () => { for (const c of conns) c.ws.terminate(); wss.close(); },
  };
}
