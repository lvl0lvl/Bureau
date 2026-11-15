import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BooksCommit, BooksEntry } from '../../../shared/contract.ts';

/**
 * The Books: shared records every member of staff works from, kept as plain files in a git
 * repository so each change is attributed, visible and reversible.
 */

const STARTER: Record<string, string> = {
  'README.md': `# The Books

Shared records for the whole office. Plain files, one topic each. Every change is recorded with
who made it and can be undone from the app.

- \`contacts.md\` — people and organisations, with email addresses. Staff may write freely only to
  addresses listed here.
- \`accounts.md\` — bank accounts, cards and subscriptions (never passwords or full numbers).
- \`obligations.md\` — renewals, filings, bills and other dates that must not be missed.
- \`ledger/\` — one file per month of income and spending.
`,
  'contacts.md': `# Contacts

One line per person: name, organisation, email, a few words of context.

`,
  'accounts.md': `# Accounts

Bank accounts, cards and subscriptions. Last four digits only. Never passwords.

`,
  'obligations.md': `# Obligations

Renewals, filings and bills. Each line: date, what, amount if known, who looks after it.

`,
};

export class Books {
  readonly dir: string;
  private emailCache: { mtime: number; set: Set<string> } | null = null;

  constructor(dir: string) {
    this.dir = dir;
  }

  private git(args: string[], opts: { author?: string } = {}): string {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: opts.author ?? 'Bureau', GIT_AUTHOR_EMAIL: 'office@bureau.local',
      GIT_COMMITTER_NAME: 'Bureau', GIT_COMMITTER_EMAIL: 'office@bureau.local',
    };
    return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: this.dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  init() {
    fs.mkdirSync(path.join(this.dir, 'ledger'), { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      this.git(['init', '-q', '-b', 'main']);
      for (const [name, body] of Object.entries(STARTER)) {
        const file = path.join(this.dir, name);
        if (!fs.existsSync(file)) fs.writeFileSync(file, body);
      }
      fs.writeFileSync(path.join(this.dir, 'ledger', '.gitkeep'), '');
      this.commit('Bureau', 'Open the Books');
    }
  }

  /** Record whatever changed. Returns the files touched, or an empty list when nothing changed. */
  commit(author: string, message: string): string[] {
    try {
      const status = this.git(['status', '--porcelain']).replace(/\s+$/, '');
      if (!status.trim()) return [];
      this.git(['add', '-A']);
      this.git(['commit', '-q', '-m', message.slice(0, 200)], { author });
      return status.split('\n').map((l) => l.slice(3));
    } catch (e) {
      console.error('[books] commit failed', (e as Error).message);
      return [];
    }
  }

  private safe(rel: string): string {
    const file = path.resolve(this.dir, rel);
    const inside = path.relative(this.dir, file);
    if (inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep)[0] === '.git') throw new Error('Outside the Books.');
    return file;
  }

  tree(): BooksEntry[] {
    const out: BooksEntry[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.git' || ent.name === '.gitkeep' || ent.name === '.DS_Store') continue;
        const full = path.join(dir, ent.name);
        const st = fs.statSync(full);
        out.push({ path: path.relative(this.dir, full), dir: ent.isDirectory(), size: st.size, modifiedAt: st.mtimeMs });
        if (ent.isDirectory()) walk(full);
      }
    };
    walk(this.dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  file(rel: string): { path: string; text: string } {
    const file = this.safe(rel);
    const st = fs.statSync(file);
    if (st.size > 2_000_000) throw new Error('That file is too large to show.');
    return { path: rel, text: fs.readFileSync(file, 'utf8') };
  }

  history(limit = 60): BooksCommit[] {
    let raw = '';
    try {
      raw = this.git(['log', `-n${limit}`, '--name-only', '--pretty=format:%x1e%H%x1f%at%x1f%an%x1f%s']);
    } catch { return []; }
    return raw.split('\x1e').filter(Boolean).map((chunk) => {
      const [head, ...files] = chunk.split('\n');
      const [sha, at, author, subject] = head!.split('\x1f');
      return { sha: sha!, at: Number(at) * 1000, author: author!, subject: subject!, files: files.map((f) => f.trim()).filter(Boolean) };
    });
  }

  /** Undo one recorded change by recording its opposite. */
  revert(sha: string, by = 'The owner'): { ok: boolean; error?: string } {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, error: 'Not a change id.' };
    try {
      this.commit('Bureau', 'Save work in progress before undoing a change');
      this.git(['revert', '--no-edit', sha], { author: by });
      this.emailCache = null;
      return { ok: true };
    } catch (e) {
      try { this.git(['revert', '--abort']); } catch { /* nothing to abort */ }
      return { ok: false, error: 'That change overlaps with later ones and cannot be undone on its own.' };
    }
  }

  /** Addresses the office already knows. Mail to anyone else counts as writing to someone new. */
  knownEmails(): Set<string> {
    const file = path.join(this.dir, 'contacts.md');
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (this.emailCache?.mtime === mtime) return this.emailCache.set;
      const set = new Set<string>();
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) set.add(m[0].toLowerCase());
      this.emailCache = { mtime, set };
      return set;
    } catch {
      return new Set();
    }
  }
}
