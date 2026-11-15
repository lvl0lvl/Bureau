import crypto from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import * as webpush from 'web-push';
import type { PushSubscription } from 'web-push';
import type { Store } from './store.ts';

/**
 * Notifications to the owner's devices when something needs a signature.
 *
 * Two routes, both sent straight from this Mac with no relay in between:
 *  - Web Push, for the web app installed to a phone's home screen. Needs nothing but HTTPS.
 *  - Apple Push (APNs), for the native iPhone app. Needs a key from the owner's Apple developer
 *    account, described in `apns.json` in the office folder. Until that file exists this route
 *    is off.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Path to open in the app, e.g. "/?slip=slip_abc". */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag: string;
  slipId?: string;
  /** Offer "Sign" on the notification itself (native app only). */
  signable?: boolean;
}

interface VapidDoc { id: 'vapid'; publicKey: string; privateKey: string }
interface WebSub { id: string; deviceId: string; origin: string; sub: PushSubscription }
interface ApnsSub { id: string; deviceId: string; token: string; sandbox: boolean }
interface ApnsConfig { keyId: string; teamId: string; bundleId: string; keyPath: string }

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 24);

export class Push {
  private store: Store;
  private home: string;
  private jwt: { token: string; at: number } | null = null;

  constructor(store: Store, home: string) {
    this.store = store;
    this.home = home;
  }

  // -------------------------------------------------------------- web push

  private vapid(): VapidDoc {
    let v = this.store.getPrivate<VapidDoc>('_vapid', 'vapid');
    if (!v) v = this.store.putPrivate<VapidDoc>('_vapid', { id: 'vapid', ...webpush.generateVAPIDKeys() });
    return v;
  }

  publicKey(): string {
    return this.vapid().publicKey;
  }

  subscribeWeb(deviceId: string, sub: PushSubscription, origin: string): boolean {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys.auth || !/^https:\/\//.test(sub.endpoint)) return false;
    this.store.putPrivate<WebSub>('_websub', { id: sha(sub.endpoint), deviceId, origin, sub });
    return true;
  }

  unsubscribeWeb(endpoint: string) {
    this.store.delPrivate('_websub', sha(endpoint));
  }

  // ------------------------------------------------------------------ apns

  apnsConfig(): ApnsConfig | null {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(this.home, 'apns.json'), 'utf8')) as ApnsConfig;
      if (c.keyId && c.teamId && c.bundleId && c.keyPath && fs.existsSync(c.keyPath)) return c;
    } catch { /* not configured */ }
    return null;
  }

  subscribeApns(deviceId: string, token: string, sandbox: boolean): boolean {
    if (!/^[0-9a-f]{64,200}$/i.test(token)) return false;
    this.store.putPrivate<ApnsSub>('_apnssub', { id: sha(token), deviceId, token: token.toLowerCase(), sandbox });
    return true;
  }

  private apnsJwt(c: ApnsConfig): string {
    // Apple wants the token reused for up to an hour, not minted per request.
    if (this.jwt && Date.now() - this.jwt.at < 40 * 60_000) return this.jwt.token;
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'ES256', kid: c.keyId })}.${b64({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: fs.readFileSync(c.keyPath, 'utf8'), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.jwt = { token: `${unsigned}.${sig}`, at: Date.now() };
    return this.jwt.token;
  }

  private sendApns(c: ApnsConfig, sub: ApnsSub, m: PushMessage): Promise<number> {
    return new Promise((resolve) => {
      const session = http2.connect(sub.sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
      const done = (status: number) => { session.close(); resolve(status); };
      session.on('error', () => resolve(0));
      const body = JSON.stringify({
        aps: { alert: { title: m.title, body: m.body }, sound: 'default', 'thread-id': 'bureau', category: m.signable ? 'SLIP_SIGNABLE' : 'SLIP', 'interruption-level': 'time-sensitive' },
        url: m.url, slipId: m.slipId,
      });
      const req = session.request({
        ':method': 'POST', ':path': `/3/device/${sub.token}`, authorization: `bearer ${this.apnsJwt(c)}`,
        'apns-topic': c.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': m.tag.slice(0, 64), 'content-type': 'application/json',
      });
      let status = 0;
      req.on('response', (h) => { status = Number(h[':status']); });
      req.on('end', () => done(status));
      req.on('error', () => done(0));
      req.setTimeout(10_000, () => { req.close(); done(0); });
      req.resume();
      req.end(body);
    });
  }

  // ------------------------------------------------------------------ send

  subscriptionCount(): { web: number; apns: number; apnsConfigured: boolean } {
    return { web: this.store.listPrivate('_websub').length, apns: this.store.listPrivate('_apnssub').length, apnsConfigured: !!this.apnsConfig() };
  }

  /** Does this device receive notifications? */
  hasDevice(deviceId: string): boolean {
    return this.store.listPrivate<WebSub>('_websub').some((s) => s.deviceId === deviceId) || this.store.listPrivate<ApnsSub>('_apnssub').some((s) => s.deviceId === deviceId);
  }

  /** Forget every subscription that belongs to a device (it was unpaired). */
  forgetDevice(deviceId: string) {
    for (const s of this.store.listPrivate<WebSub>('_websub')) if (s.deviceId === deviceId) this.store.delPrivate('_websub', s.id);
    for (const s of this.store.listPrivate<ApnsSub>('_apnssub')) if (s.deviceId === deviceId) this.store.delPrivate('_apnssub', s.id);
  }

  async notify(m: PushMessage): Promise<void> {
    const v = this.vapid();
    const jobs: Promise<void>[] = [];

    for (const s of this.store.listPrivate<WebSub>('_websub')) {
      jobs.push(
        webpush.sendNotification(s.sub, JSON.stringify(m), {
          // The subject identifies the sender to the push service; our own address is the honest answer.
          vapidDetails: { subject: s.origin, publicKey: v.publicKey, privateKey: v.privateKey },
          TTL: 6 * 3600, urgency: 'high', topic: m.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
        }).then(() => undefined).catch((e: { statusCode?: number }) => {
          if (e?.statusCode === 404 || e?.statusCode === 410) this.store.delPrivate('_websub', s.id);
          else console.error('[push] web push failed', e?.statusCode ?? e);
        }),
      );
    }

    const apns = this.apnsConfig();
    if (apns) {
      for (const s of this.store.listPrivate<ApnsSub>('_apnssub')) {
        jobs.push(this.sendApns(apns, s, m).then((status) => {
          if (status === 410 || status === 400) this.store.delPrivate('_apnssub', s.id);
          else if (status !== 200) console.error('[push] apns failed', status);
        }));
      }
    }
    await Promise.all(jobs);
  }
}
