import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restore } from './backup.ts';

/**
 * Rebuild an office from a backup:
 *
 *   pnpm office:restore <archive> <new folder>
 *
 * The recovery key is asked for (it is not shown as it is pasted), or read from standard input
 * when something is piped in, for example from 1Password's command-line tool.
 */

const expand = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

function readHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const done = (fn: () => void) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); fn(); };
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buf));
        if (ch === '\u0003') return done(() => reject(new Error('Stopped.')));
        if (ch === '\u007f') buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPiped(): Promise<string> {
  let buf = '';
  for await (const chunk of process.stdin) buf += String(chunk);
  return buf;
}

const [archiveArg, destArg] = process.argv.slice(2);
if (!archiveArg || !destArg) {
  console.log('Usage: pnpm office:restore <archive> <new folder>');
  console.log('  <archive>     a file from the Backups folder, named like bureau-2026-11-13-0300.tar.gz.age');
  console.log('  <new folder>  where to rebuild the office; it must not exist yet, or be empty');
  process.exit(2);
}

try {
  const archive = path.resolve(expand(archiveArg));
  const dest = path.resolve(expand(destArg));
  if (!fs.existsSync(archive)) throw new Error(`There is no archive at ${archive}.`);
  const key = process.stdin.isTTY ? await readHidden('Paste the recovery key and press Return (it will not be shown): ') : await readPiped();
  const done = await restore({ archive, dest, key });
  const m = done.manifest as { madeAt?: string; staff?: string[]; host?: string } | null;
  console.log(`Restored to ${done.dest}.`);
  if (m?.madeAt) console.log(`  The backup was made on ${new Date(m.madeAt).toLocaleString()}${m.host ? ` on ${m.host}` : ''}${m.staff?.length ? `, with staff ${m.staff.join(', ')}` : ''}.`);
  console.log('  To run this office, stop Bureau, then either move this folder to ~/Bureau (after moving the old one aside)');
  console.log(`  or start Bureau on it directly:  BUREAU_HOME="${done.dest}" pnpm start`);
  console.log('  The skills catalog is not part of a backup. Fetch it again in Settings if you need it.');
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
