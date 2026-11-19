import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * How the owner's other devices reach this office: the Tailscale address that Tailscale Serve
 * points at it, if any. Read from the `tailscale` command, which says only what this Mac has
 * already been told to do (`scripts/remote.sh` sets it up); nothing here changes it.
 */

export interface Reach {
  /** The https address other devices use, or null when none leads here. */
  address: string | null;
  /** Tailscale is installed and signed in on this Mac. */
  tailscale: boolean;
  /** Another app is served at this Mac's own Tailscale address (port 443), so Bureau is not. */
  taken: string | null;
}

/** Read `tailscale status --json` and `tailscale serve status --json` for an office on `port`. */
export function readReach(status: unknown, serve: unknown, port: number): Reach {
  const self = (status as { Self?: { DNSName?: string }; BackendState?: string } | null) ?? {};
  const name = (self.Self?.DNSName ?? '').replace(/\.$/, '');
  const running = (status as { BackendState?: string } | null)?.BackendState === 'Running';
  if (!name || !running) return { address: null, tailscale: false, taken: null };
  const web = ((serve as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null)?.Web) ?? {};
  const ours = (proxy: string | undefined) => !!proxy && new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}/?$`).test(proxy);
  let address: string | null = null;
  let taken: string | null = null;
  for (const [hostPort, entry] of Object.entries(web)) {
    const [host, p = '443'] = hostPort.split(':');
    if (host !== name) continue;
    const proxy = entry.Handlers?.['/']?.Proxy;
    if (ours(proxy)) {
      // The default port wins over any other port that also leads here.
      if (!address || p === '443') address = `https://${name}${p === '443' ? '' : `:${p}`}`;
    } else if (p === '443' && proxy) {
      taken = proxy;
    }
  }
  return { address, tailscale: true, taken: address ? null : taken };
}

const CANDIDATES = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

function tailscaleBin(): string | null {
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const c = path.join(dir, 'tailscale');
    if (dir && fs.existsSync(c)) return c;
  }
  return null;
}

function json(bin: string, args: string[]): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 4000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

let cached: { at: number; port: number; value: Promise<Reach> } | null = null;

/** The office's address for other devices, looked up at most once a minute. */
export function reach(port: number, fresh = false): Promise<Reach> {
  if (process.env.BUREAU_REACH) {
    // Fixed for demo offices and tests: "https://name.example.ts.net", or "none".
    const a = process.env.BUREAU_REACH;
    return Promise.resolve({ address: a === 'none' ? null : a, tailscale: a !== 'none', taken: null });
  }
  if (!fresh && cached && cached.port === port && Date.now() - cached.at < 60_000) return cached.value;
  const bin = tailscaleBin();
  const value = bin
    ? Promise.all([json(bin, ['status', '--json']), json(bin, ['serve', 'status', '--json'])]).then(([s, v]) => readReach(s, v, port))
    : Promise.resolve<Reach>({ address: null, tailscale: false, taken: null });
  cached = { at: Date.now(), port, value };
  return value;
}
