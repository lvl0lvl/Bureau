import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InstalledSkill, Staff } from '../../../shared/contract.ts';
import { listFiles, isScript, type Catalog } from './catalog.ts';
import type { Store } from './store.ts';

/**
 * Skills that belong to one member of staff.
 *
 * A skill is a folder under `<staff folder>/.claude/skills/`. Claude Code loads it for that person
 * only, and only reads its instructions when a piece of work calls for it.
 *
 * The owner decides what is installed; staff do not. A member of staff can run commands in their
 * own folder, so the gate alone cannot stop one from rewriting a skill after reading something
 * hostile. Instead the office remembers a hash of every skill it installed and checks the folder
 * before each piece of work. Anything that changed, or appeared without being installed, is moved
 * out of the staff folder and reported. Nothing a member of staff writes there can carry over.
 */

const MAX_FILES = 400;
const MAX_BYTES = 12 * 1024 * 1024;

/** Names inside a staff folder that the office owns. Staff may not write to them. */
export const OFFICE_OWNED = ['.claude', 'CLAUDE.md', 'BRIEFING.md', '.mcp.json'];

export function isOfficeOwned(relPath: string): boolean {
  const first = relPath.split(path.sep)[0] ?? '';
  return OFFICE_OWNED.includes(first);
}

export function hashFolder(dir: string): string {
  const h = crypto.createHash('sha256');
  for (const f of listFiles(dir, 5000)) {
    h.update(f.rel.split(path.sep).join('/'));
    h.update('\0');
    h.update(fs.readFileSync(path.join(dir, f.rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'skill';

const claudeMd = (name: string) => `# ${name}'s folder

What you have written down for yourself is loaded below at the start of every conversation.

@notes/memory.md
`;

export class Skills {
  private store: Store;
  private catalog: Catalog;
  private staffRoot: string;
  private heldRoot: string;

  constructor(deps: { store: Store; catalog: Catalog; staffRoot: string; heldRoot: string }) {
    this.store = deps.store;
    this.catalog = deps.catalog;
    this.staffRoot = deps.staffRoot;
    this.heldRoot = deps.heldRoot;
  }

  private home(staffId: string) { return path.join(this.staffRoot, staffId); }
  private skillsDir(staffId: string) { return path.join(this.home(staffId), '.claude', 'skills'); }

  /** Copy a catalog skill into one person's folder. Throws with a sentence the owner can read. */
  install(staffId: string, ref: string): InstalledSkill {
    const staff = this.store.get('staff', staffId);
    if (!staff || staff.retired) throw new Error('No such member of staff.');
    const found = this.catalog.locate(ref);
    if (!found) throw new Error('That skill is not in the catalog. Refresh the catalog and try again.');

    const files = listFiles(found.dir, MAX_FILES + 1);
    if (files.length > MAX_FILES) throw new Error(`“${found.skill.name}” has more than ${MAX_FILES} files, which is more than a skill should need.`);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    if (bytes > MAX_BYTES) throw new Error(`“${found.skill.name}” is ${Math.round(bytes / 1024 / 1024)} MB, which is more than a skill should need.`);

    const have = staff.skills ?? [];
    const again = have.find((s) => s.ref === ref);
    let id = again?.id ?? slug(path.basename(found.dir) === '.' ? found.skill.name : path.basename(found.dir));
    if (!again) for (let n = 2; have.some((s) => s.id === id); n += 1) id = `${slug(found.skill.name)}-${n}`;

    const dest = path.join(this.skillsDir(staffId), id);
    fs.rmSync(dest, { recursive: true, force: true });
    for (const f of files) {
      const to = path.join(dest, f.rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(found.dir, f.rel), to);
    }

    const installed: InstalledSkill = {
      id, name: found.skill.name, description: found.skill.description, source: found.skill.source, plugin: found.skill.plugin,
      ref, commit: found.commit, hash: hashFolder(dest), files: files.length,
      scripts: files.filter((f) => isScript(f.rel, f.mode)).length, installedAt: Date.now(),
    };
    this.store.update('staff', staffId, (s) => { s.skills = [...(s.skills ?? []).filter((x) => x.id !== id), installed]; });
    return installed;
  }

  remove(staffId: string, skillId: string): boolean {
    const staff = this.store.get('staff', staffId);
    if (!staff || !(staff.skills ?? []).some((s) => s.id === skillId)) return false;
    fs.rmSync(path.join(this.skillsDir(staffId), skillId), { recursive: true, force: true });
    this.store.update('staff', staffId, (s) => { s.skills = (s.skills ?? []).filter((x) => x.id !== skillId); });
    return true;
  }

  private setAside(staffId: string, target: string): void {
    const to = path.join(this.heldRoot, staffId, `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(target)}`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(target, to);
    } catch {
      fs.cpSync(target, to, { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  /**
   * Put a staff folder back the way the office set it up, before a piece of work starts.
   * Returns a sentence for each thing that was found changed and set aside.
   */
  guard(staff: Pick<Staff, 'id' | 'name' | 'skills'>, briefing?: string): string[] {
    const home = this.home(staff.id);
    const found: string[] = [];
    fs.mkdirSync(path.join(home, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(home, 'library'), { recursive: true });

    const dotClaude = path.join(home, '.claude');
    if (fs.existsSync(dotClaude)) {
      for (const name of fs.readdirSync(dotClaude)) {
        if (name === 'skills' || name === '.DS_Store') continue;
        this.setAside(staff.id, path.join(dotClaude, name));
        found.push(`Something called “.claude/${name}” appeared in ${staff.name}’s folder. Settings and add-ons there are not something staff set up for themselves, so it was moved out.`);
      }
    }
    if (fs.existsSync(path.join(home, '.mcp.json'))) {
      this.setAside(staff.id, path.join(home, '.mcp.json'));
      found.push(`A connector file appeared in ${staff.name}’s folder and was moved out.`);
    }

    const installed = staff.skills ?? [];
    const held = new Set<string>();
    const skillsDir = this.skillsDir(staff.id);
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        if (name === '.DS_Store') continue;
        if (installed.some((s) => s.id === name && !s.held)) continue;
        this.setAside(staff.id, path.join(skillsDir, name));
        if (!installed.some((s) => s.id === name)) found.push(`A skill folder called “${name}” appeared in ${staff.name}’s folder without being installed. It was moved out and is not in use.`);
      }
    }
    for (const s of installed) {
      if (s.held) continue;
      const dir = path.join(skillsDir, s.id);
      if (!fs.existsSync(dir)) {
        held.add(s.id);
        found.push(`The skill “${s.name}” is missing from ${staff.name}’s folder. Install it again from their page in Settings.`);
      } else if (hashFolder(dir) !== s.hash) {
        this.setAside(staff.id, dir);
        held.add(s.id);
        found.push(`The skill “${s.name}” was changed after it was installed, so it was moved out and is not in use. Install it again from ${staff.name}’s page in Settings.`);
      }
    }
    if (held.size) {
      this.store.update('staff', staff.id, (doc) => { doc.skills = (doc.skills ?? []).map((s) => (held.has(s.id) ? { ...s, held: true } : s)); });
    }

    const write = (file: string, text: string) => {
      const full = path.join(home, file);
      let cur: string | null = null;
      try { cur = fs.readFileSync(full, 'utf8'); } catch { /* not there yet */ }
      if (cur !== text) fs.writeFileSync(full, text);
    };
    write('CLAUDE.md', claudeMd(staff.name));
    if (briefing !== undefined) {
      write('BRIEFING.md', `<!-- Written by Bureau before each piece of work. It is a copy of what ${staff.name} is told.\n     Changes made here are replaced. Edit the profile on ${staff.name}'s page in Settings. -->\n\n${briefing}\n`);
    }
    return found;
  }
}
