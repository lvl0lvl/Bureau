import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CatalogPage, CatalogPlugin, CatalogSkill, CatalogSkillDetail, CatalogSource } from '../../../shared/contract.ts';
import type { Store } from './store.ts';

/**
 * The catalog: skills the owner can give to staff.
 *
 * A source is a public GitHub repository (Anthropic's collections by default). It is copied to
 * `<office>/catalog/<id>` only when the owner asks, never in the background, and nothing in it is
 * run. Installing a skill copies its folder into one staff member's own folder (see skills.ts),
 * so a later refresh of the catalog changes nothing that is already installed.
 */

interface StoredSource {
  id: string;
  repo: string;
  label: string;
  official: boolean;
  /** A folder on this Mac instead of a repository (the demo's samples, and tests). */
  local?: string;
  fetchedAt: number | null;
  commit: string | null;
  error?: string;
}

interface Indexed {
  skill: CatalogSkill;
  dir: string;
  pluginId: string | null;
}

const DEFAULT_SOURCES: Omit<StoredSource, 'fetchedAt' | 'commit'>[] = [
  { id: 'anthropic-knowledge-work', repo: 'anthropics/knowledge-work-plugins', label: 'Anthropic knowledge work plugins', official: true },
  { id: 'anthropic-skills', repo: 'anthropics/skills', label: 'Anthropic skills', official: true },
  { id: 'anthropic-financial-services', repo: 'anthropics/financial-services-plugins', label: 'Anthropic financial services plugins', official: true },
];

const SCRIPT_EXT = new Set(['.py', '.sh', '.bash', '.zsh', '.js', '.mjs', '.cjs', '.ts', '.rb', '.pl', '.php', '.ps1', '.swift', '.go']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '__pycache__', '.venv', 'dist', 'build']);
const MAX_DEPTH = 8;
const STOP = new Set(['the', 'and', 'for', 'with', 'who', 'that', 'this', 'from', 'will', 'you', 'your', 'our', 'are', 'someone', 'person', 'agent', 'staff', 'skill', 'skills', 'help', 'work', 'does', 'can']);

export function isScript(file: string, mode = 0): boolean {
  return SCRIPT_EXT.has(path.extname(file).toLowerCase()) || (mode & 0o111) !== 0;
}

/** The front matter of a SKILL.md: only the plain `key: value` lines are needed. */
export function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    const block = /^[>|][+-]?$/.test(value);
    if (block) value = '';
    // Indented lines that follow belong to this value (a block, or a plain value that wraps).
    const more: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || (block && lines[i + 1]!.trim() === ''))) {
      i += 1;
      more.push(lines[i]!.trim());
    }
    if (more.length) value = [value, ...more].filter(Boolean).join(' ');
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    meta[kv[1]!] = value.replace(/\\"/g, '"').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Every regular file under a folder. Links are never followed. */
export function listFiles(dir: string, limit = 2000): { rel: string; size: number; mode: number }[] {
  const out: { rel: string; size: number; mode: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 12 || out.length >= limit) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      const st = fs.statSync(full);
      out.push({ rel: path.relative(dir, full), size: st.size, mode: st.mode });
    }
  };
  walk(dir, 0);
  return out;
}

const run = (cmd: string, args: string[], cwd?: string) => new Promise<string>((resolve, reject) => {
  execFile(cmd, args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ')));
    else resolve(stdout.trim());
  });
});

export class Catalog {
  private store: Store;
  readonly dir: string;
  private index: { skills: Map<string, Indexed>; plugins: Map<string, CatalogPlugin> } | null = null;

  constructor(store: Store, dir: string) {
    this.store = store;
    this.dir = dir;
  }

  // ------------------------------------------------------------ sources

  private stored(): StoredSource[] {
    const doc = this.store.getPrivate<{ id: string; list: StoredSource[] }>('_catalog', 'sources');
    if (doc) return doc.list;
    const list = DEFAULT_SOURCES.map((s) => ({ ...s, fetchedAt: null, commit: null }));
    this.store.putPrivate('_catalog', { id: 'sources', list });
    return list;
  }

  private save(list: StoredSource[]) {
    this.store.putPrivate('_catalog', { id: 'sources', list });
    this.index = null;
  }

  private root(s: StoredSource): string {
    return s.local ?? path.join(this.dir, s.id);
  }

  sources(): CatalogSource[] {
    const idx = this.build();
    return this.stored().map((s) => ({
      id: s.id, repo: s.repo, label: s.label, official: s.official, fetchedAt: s.fetchedAt, commit: s.commit, error: s.error,
      skills: [...idx.skills.values()].filter((x) => x.skill.sourceId === s.id).length,
    }));
  }

  /** Add a public GitHub repository as a source. Nothing is fetched until refresh. */
  addSource(repoText: string): CatalogSource {
    const repo = repoText.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo)) throw new Error('Give a GitHub repository as owner/name, for example anthropics/skills.');
    const list = this.stored();
    if (list.some((s) => s.repo.toLowerCase() === repo.toLowerCase())) throw new Error('That source is already in the catalog.');
    const id = repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const source: StoredSource = { id, repo, label: repo, official: /^anthropics\//i.test(repo), fetchedAt: null, commit: null };
    this.save([...list, source]);
    return this.sources().find((s) => s.id === id)!;
  }

  /** A folder on this Mac as a source: the demo's samples, and tests. */
  addLocal(id: string, label: string, folder: string) {
    const all = this.stored();
    const had = all.find((s) => s.id === id);
    if (had && had.local === folder && had.label === label) return;
    // Listed first: these are the office's own.
    this.save([{ id, repo: folder, label, official: false, local: folder, fetchedAt: Date.now(), commit: null }, ...all.filter((s) => s.id !== id)]);
  }

  removeSource(id: string) {
    const list = this.stored();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    this.save(list.filter((x) => x.id !== id));
    if (!s.local) fs.rmSync(path.join(this.dir, s.id), { recursive: true, force: true });
  }

  /** Fetch a source again from GitHub. Only ever called because the owner asked. */
  async refresh(id: string): Promise<CatalogSource> {
    const s = this.stored().find((x) => x.id === id);
    if (!s) throw new Error('No such source.');
    if (s.local) return this.sources().find((x) => x.id === id)!;
    const dest = path.join(this.dir, s.id);
    const fresh = `${dest}.new`;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.rmSync(fresh, { recursive: true, force: true });
    let patch: Partial<StoredSource>;
    try {
      await run('git', ['clone', '--depth', '1', '--single-branch', '--no-tags', '--quiet', `https://github.com/${s.repo}.git`, fresh]);
      const commit = await run('git', ['rev-parse', 'HEAD'], fresh);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(fresh, dest);
      patch = { fetchedAt: Date.now(), commit, error: undefined };
    } catch (e) {
      fs.rmSync(fresh, { recursive: true, force: true });
      patch = { error: `Could not fetch ${s.repo}: ${(e as Error).message}`.slice(0, 300) };
    }
    this.save(this.stored().map((x) => (x.id === id ? { ...x, ...patch } : x)));
    return this.sources().find((x) => x.id === id)!;
  }

  async refreshAll(): Promise<CatalogSource[]> {
    for (const s of this.stored()) if (!s.local) await this.refresh(s.id);
    return this.sources();
  }

  // -------------------------------------------------------------- index

  private build() {
    if (this.index) return this.index;
    const skills = new Map<string, Indexed>();
    const plugins = new Map<string, CatalogPlugin>();

    for (const source of this.stored()) {
      const root = this.root(source);
      if (!fs.existsSync(root)) continue;

      // A marketplace file can name plugin folders that carry no manifest of their own.
      const listed = new Map<string, { name: string; description: string }>();
      const market = readJson(path.join(root, '.claude-plugin', 'marketplace.json'));
      for (const p of Array.isArray(market?.plugins) ? market.plugins : []) {
        if (typeof p?.source === 'string' && typeof p?.name === 'string') {
          listed.set(path.resolve(root, p.source), { name: p.name, description: typeof p.description === 'string' ? p.description : '' });
        }
      }

      const walk = (dir: string, depth: number, pluginId: string | null) => {
        if (depth > MAX_DEPTH) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        const names = new Set(entries.map((e) => e.name));

        const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json'));
        const fromMarket = listed.get(dir);
        if ((manifest && typeof manifest === 'object') || fromMarket) {
          const rel = path.relative(root, dir) || '.';
          pluginId = `${source.id}:${rel}`;
          const mcp = readJson(path.join(dir, '.mcp.json'));
          const servers = { ...(mcp?.mcpServers ?? {}), ...(typeof manifest?.mcpServers === 'object' ? manifest.mcpServers : {}) };
          const count = (sub: string) => { try { return fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.md')).length; } catch { return 0; } };
          plugins.set(pluginId, {
            id: pluginId, sourceId: source.id,
            name: String(manifest?.name ?? fromMarket?.name ?? path.basename(dir)),
            description: String(manifest?.description ?? fromMarket?.description ?? ''),
            skills: 0, connectors: Object.keys(servers), hooks: fs.existsSync(path.join(dir, 'hooks')) || !!manifest?.hooks,
            commands: count('commands'), agents: count('agents'),
          });
        }

        if (names.has('SKILL.md')) {
          let text = '';
          try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return; }
          const { meta } = frontMatter(text);
          const files = listFiles(dir);
          const rel = path.relative(root, dir) || '.';
          const id = `${source.id}:${rel}`;
          const plugin = pluginId ? plugins.get(pluginId) ?? null : null;
          if (plugin) plugin.skills += 1;
          skills.set(id, {
            dir, pluginId,
            skill: {
              id, name: (meta.name || path.basename(dir)).slice(0, 80), description: (meta.description || '').slice(0, 1200),
              sourceId: source.id, source: source.label, official: source.official, plugin: plugin?.name ?? null,
              files: files.length, scripts: files.filter((f) => isScript(f.rel, f.mode)).length, bytes: files.reduce((n, f) => n + f.size, 0),
            },
          });
          return; // A skill's own subfolders are part of the skill.
        }

        for (const e of entries) {
          if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue;
          if (e.name.startsWith('.') && e.name !== '.claude') continue;
          walk(path.join(dir, e.name), depth + 1, pluginId);
        }
      };
      walk(root, 0, null);
    }
    this.index = { skills, plugins };
    return this.index;
  }

  /** Skills matching a few words, best first. An empty search lists everything. */
  search(query: string, opts: { limit?: number; sourceId?: string } = {}): CatalogPage {
    const all = [...this.build().skills.values()].map((x) => x.skill).filter((s) => !opts.sourceId || s.sourceId === opts.sourceId);
    const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)))];
    let found: CatalogSkill[];
    if (!words.length) {
      found = all.sort((a, b) => Number(b.official) - Number(a.official) || a.source.localeCompare(b.source) || (a.plugin ?? '').localeCompare(b.plugin ?? '') || a.name.localeCompare(b.name));
    } else {
      const scored = all.map((s) => {
        const name = s.name.toLowerCase();
        const plugin = (s.plugin ?? '').toLowerCase();
        const text = s.description.toLowerCase();
        let score = 0;
        for (const w of words) {
          // "invoices" should find "invoice" and the other way round.
          const stem = w.length > 4 ? w.replace(/(ing|es|s)$/, '') : w;
          // Match at the start of a word, so "tax" does not find "syntax".
          const at = new RegExp(`(^|[^a-z0-9])${stem.replace(/[^a-z0-9]/g, '')}`);
          if (at.test(name)) score += 5;
          if (at.test(plugin)) score += 3;
          if (at.test(text)) score += 1;
        }
        return { s, score };
      }).filter((x) => x.score > 0);
      found = scored.sort((a, b) => b.score - a.score || Number(b.s.official) - Number(a.s.official) || a.s.name.localeCompare(b.s.name)).map((x) => x.s);
    }
    return { sources: this.sources(), skills: found.slice(0, opts.limit ?? 60), total: found.length };
  }

  get(id: string): CatalogSkill | undefined {
    return this.build().skills.get(id)?.skill;
  }

  /** Where a catalog skill's files are, and which version of the source they come from. */
  locate(id: string): { dir: string; skill: CatalogSkill; commit: string | null } | undefined {
    const x = this.build().skills.get(id);
    if (!x) return undefined;
    return { dir: x.dir, skill: x.skill, commit: this.stored().find((s) => s.id === x.skill.sourceId)?.commit ?? null };
  }

  detail(id: string): CatalogSkillDetail | undefined {
    const x = this.build().skills.get(id);
    if (!x) return undefined;
    let text = '';
    try { text = fs.readFileSync(path.join(x.dir, 'SKILL.md'), 'utf8'); } catch { /* shown empty */ }
    const files = listFiles(x.dir, 400);
    return {
      ...x.skill,
      body: frontMatter(text).body.trim().slice(0, 60_000),
      fileList: files.map((f) => ({ path: f.rel, size: f.size, script: isScript(f.rel, f.mode) })),
      pluginInfo: x.pluginId ? this.build().plugins.get(x.pluginId) ?? null : null,
    };
  }
}
