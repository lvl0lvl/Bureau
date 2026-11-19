import crypto from 'node:crypto';
import type { Device } from '../../../shared/contract.ts';
import { newId, type Store } from './store.ts';

/**
 * Who may talk to the server.
 *
 * A device is paired once with a short one-time code and then holds a long-lived cookie. A
 * browser on this Mac itself (plain loopback, not arriving through a proxy such as Tailscale
 * Serve) is paired automatically, so first run needs no code.
 */

/** The label of a session given to a browser on the Mac itself, which needs no code. */
const LOCAL_LABEL = 'This Mac';

interface DeviceDoc { id: string; label: string; hash: string; createdAt: number; lastSeenAt: number }
interface CodeDoc { id: string; expiresAt: number }

const COOKIE = 'bureau_session';
const YEAR = 365 * 24 * 3600;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class Auth {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** Is this request made on the Mac itself, not forwarded from elsewhere? */
  static isLocal(remoteAddress: string | undefined, headers: { host?: string; forwardedFor?: string }): boolean {
    if (process.env.BUREAU_REQUIRE_PAIRING === '1') return false;
    const addr = remoteAddress ?? '';
    const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
    if (!loopback || headers.forwardedFor) return false;
    const host = (headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    // The Host check stops a web page elsewhere from reaching this server by pointing a name at 127.0.0.1.
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  }

  private issue(label: string): { device: DeviceDoc; cookieValue: string } {
    const secret = crypto.randomBytes(32).toString('base64url');
    const device = this.store.putPrivate<DeviceDoc>('_device', { id: newId('dev'), label: label.trim().slice(0, 60) || 'A device', hash: sha(secret), createdAt: Date.now(), lastSeenAt: Date.now() });
    return { device, cookieValue: `${device.id}.${secret}` };
  }

  pairLocal(): string {
    return this.issue(LOCAL_LABEL).cookieValue;
  }

  /**
   * Drop sessions given to this Mac that were never used again: a script, a private window or a
   * browser that made one request. Losing one costs nothing, because this Mac is paired again
   * without a code. `keep` protects a device the caller still needs.
   */
  pruneLocal(keep: (id: string) => boolean = () => false): number {
    const cutoff = Date.now() - 10 * 60_000;
    let dropped = 0;
    for (const d of this.store.listPrivate<DeviceDoc>('_device')) {
      if (d.label !== LOCAL_LABEL || d.lastSeenAt !== d.createdAt || d.createdAt > cutoff || keep(d.id)) continue;
      this.store.delPrivate('_device', d.id);
      dropped++;
    }
    return dropped;
  }

  createCode(): { code: string; expiresAt: number } {
    for (const c of this.store.listPrivate<CodeDoc>('_code')) if (c.expiresAt < Date.now()) this.store.delPrivate('_code', c.id);
    const bytes = crypto.randomBytes(8);
    const code = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const expiresAt = Date.now() + 10 * 60_000;
    this.store.putPrivate<CodeDoc>('_code', { id: code, expiresAt });
    return { code, expiresAt };
  }

  /** Exchange a one-time code for a device session. */
  pair(code: string, label: string): string | null {
    const id = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    // A code made by `pnpm pair` is written by another process, so look in the database too.
    const doc = this.store.getPrivate<CodeDoc>('_code', id) ?? this.store.readPrivate<CodeDoc>('_code', id);
    if (!doc) return null;
    this.store.delPrivate('_code', id);
    if (doc.expiresAt < Date.now()) return null;
    return this.issue(label).cookieValue;
  }

  verify(cookieHeader: string | undefined): DeviceDoc | null {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader ?? '');
    if (!m) return null;
    const [id, secret] = decodeURIComponent(m[1]!).split('.');
    if (!id || !secret) return null;
    const device = this.store.getPrivate<DeviceDoc>('_device', id);
    if (!device) return null;
    const a = Buffer.from(device.hash);
    const b = Buffer.from(sha(secret));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() - device.lastSeenAt > 60_000) this.store.putPrivate<DeviceDoc>('_device', { ...device, lastSeenAt: Date.now() });
    return device;
  }

  cookie(value: string, secure: boolean): string {
    return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}${secure ? '; Secure' : ''}`;
  }

  devices(currentId?: string): Device[] {
    return this.store.listPrivate<DeviceDoc>('_device')
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((d) => ({ id: d.id, rev: 0, label: d.label, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, current: d.id === currentId }));
  }

  revoke(id: string) {
    this.store.delPrivate('_device', id);
  }
}
