import type { ClientMsg, ServerMsg } from '@shared/contract.ts';

export interface SocketHandlers {
  onOpen(): void;
  onMessage(msg: ServerMsg): void;
  onClose(): void;
}

export interface Socket {
  send(msg: ClientMsg): void;
  close(): void;
}

/** Everything the app needs from a server. The real one talks HTTP and WebSocket; fixtures fake it in memory. */
export interface Transport {
  kind: 'http' | 'fixtures';
  http<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
  socket(handlers: SocketHandlers): Socket;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const httpTransport: Transport = {
  kind: 'http',
  async http<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* plain text answer */
    }
    if (!res.ok) {
      const fromBody = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : '';
      throw new HttpError(res.status, fromBody || res.statusText || 'Request failed');
    }
    return data as T;
  },
  socket(handlers) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/sync`);
    let open = false;
    ws.onopen = () => {
      open = true;
      handlers.onOpen();
    };
    ws.onmessage = (e) => {
      try {
        handlers.onMessage(JSON.parse(String(e.data)) as ServerMsg);
      } catch (err) {
        console.error('bad message from server', err);
      }
    };
    ws.onclose = () => handlers.onClose();
    ws.onerror = () => {
      /* onclose follows */
    };
    return {
      send(msg) {
        if (open && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close() {
        ws.onclose = null;
        ws.onmessage = null;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      },
    };
  },
};
