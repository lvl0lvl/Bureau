import type { Hire, HireSkill, Level, Staff } from '../../../shared/contract.ts';
import { ACTION_CLASSES, staffColor } from '../../../shared/contract.ts';
import type { Catalog } from './catalog.ts';
import type { Skills } from './skills.ts';
import { newId, type Store } from './store.ts';

/**
 * Hiring: a proposed setup for a member of staff.
 *
 * The chief of staff works the proposal out in conversation with the owner, over as many rounds
 * as it takes, and saves it as a draft. The owner can change anything in the draft. Nothing
 * exists (no person, no folder, no skill) until the owner signs it.
 */

/** Where everyone starts: looking and drafting. Authority is earned. */
export function starterAuthority(): Record<string, Level> {
  const a: Record<string, Level> = {};
  for (const c of ['web.read', 'scripts.run', 'apps.other']) a[c] = 1;
  for (const c of ['mail.send', 'mail.send_new', 'books.change']) a[c] = 2;
  a['team.assign'] = 3;
  return a;
}

/** Keep only real classes and real levels. Money stays locked; checking slips stays with the chief. */
export function cleanAuthority(given: unknown, base: Record<string, Level>, opts: { cap?: Level; chief?: boolean } = {}): Record<string, Level> {
  const out: Record<string, Level> = {};
  const g = (given && typeof given === 'object' ? given : {}) as Record<string, unknown>;
  for (const c of ACTION_CLASSES) {
    const before = base[c.id] ?? 0;
    if (c.locked) continue;
    if (c.chiefOnly && !opts.chief) continue;
    let level = before as number;
    const raw = g[c.id];
    if (typeof raw === 'number' && Number.isFinite(raw)) level = Math.min(4, Math.max(0, Math.round(raw)));
    // A proposal from staff cannot hand out more than the owner already gave.
    if (opts.cap !== undefined && level > opts.cap && level > before) level = Math.max(before, opts.cap);
    if (level > 0) out[c.id] = level as Level;
  }
  return out;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

export interface ProposeInput {
  hireId?: string;
  /** Name of an existing member of staff to set up again. */
  staff?: string;
  name?: string;
  role?: string;
  about?: string;
  profile?: string;
  authority?: Record<string, number>;
  skills?: { id: string; take?: boolean; why?: string }[];
  note?: string;
}

export class Hires {
  private store: Store;
  private catalog: Catalog;
  private skills: Skills;
  private ensureHome: (staff: Pick<Staff, 'id' | 'name'>) => void;

  constructor(deps: { store: Store; catalog: Catalog; skills: Skills; ensureHome: (staff: Pick<Staff, 'id' | 'name'>) => void }) {
    this.store = deps.store;
    this.catalog = deps.catalog;
    this.skills = deps.skills;
    this.ensureHome = deps.ensureHome;
  }

  drafts(): Hire[] {
    return this.store.list('hire').filter((h) => h.status === 'draft').sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Save or revise a draft on behalf of the chief of staff. Returns what to tell them. */
  propose(by: string, input: ProposeInput): { hire?: Hire; message: string } {
    const now = Date.now();
    let cur = input.hireId ? this.store.get('hire', input.hireId) : undefined;
    if (input.hireId && !cur) return { message: `There is no draft called ${input.hireId}. Leave hire_id out to start a new one.` };
    if (cur && cur.status !== 'draft') return { message: `That draft was already ${cur.status === 'hired' ? 'signed' : 'dropped'}. Leave hire_id out to start a new one.` };

    let target: Staff | undefined;
    if (cur?.staffId) target = this.store.get('staff', cur.staffId);
    else if (!cur && input.staff) {
      target = this.store.list('staff').find((s) => !s.retired && s.name.toLowerCase() === input.staff!.trim().toLowerCase());
      if (!target) return { message: `There is nobody called ${input.staff}. To propose someone new, leave "staff" out.` };
    }

    const unknown: string[] = [];
    let picks: HireSkill[] | undefined;
    if (input.skills) {
      picks = [];
      for (const s of input.skills) {
        const found = this.catalog.get(String(s.id));
        if (!found) { unknown.push(String(s.id)); continue; }
        if (picks.some((p) => p.ref === found.id)) continue;
        picks.push({
          ref: found.id, name: found.name, description: found.description, source: found.source, plugin: found.plugin, scripts: found.scripts,
          take: s.take !== false, why: (text(s.why, 300) ?? ''),
        });
      }
    }

    const base = cur?.authority ?? target?.authority ?? starterAuthority();
    const authority = cleanAuthority(input.authority, base, { cap: 3, chief: !!target?.isChief });
    const name = text(input.name, 60) ?? cur?.name ?? target?.name ?? '';
    const next: Omit<Hire, 'rev'> = {
      id: cur?.id ?? newId('hire'),
      staffId: cur?.staffId ?? target?.id ?? null,
      status: 'draft',
      name,
      letter: (cur && cur.name === name ? cur.letter : name[0]?.toUpperCase()) ?? '?',
      color: cur?.color ?? target?.color ?? null,
      role: text(input.role, 60) ?? cur?.role ?? target?.role ?? '',
      about: text(input.about, 600) ?? cur?.about ?? target?.about ?? '',
      profile: text(input.profile, 8000) ?? cur?.profile ?? target?.instructions ?? '',
      authority,
      skills: picks ?? cur?.skills ?? [],
      note: text(input.note, 600) ?? '',
      proposedBy: by,
      createdAt: cur?.createdAt ?? now,
      updatedAt: now,
    };
    if (!next.name || !next.role) return { message: 'A proposal needs at least a name and a role.' };
    const hire = this.store.put('hire', next);
    const taking = hire.skills.filter((s) => s.take).length;
    return {
      hire,
      message: [
        `${cur ? 'Revised' : 'Saved'} the draft ${hire.id}: ${hire.name}, ${hire.role}, with ${taking} skill${taking === 1 ? '' : 's'} to install.`,
        'The owner sees it beside this conversation and can change anything in it. Nothing exists until the owner signs it; you cannot sign it.',
        `To revise it, call propose_hire again with hire_id "${hire.id}" and only the parts that change.`,
        unknown.length ? `Not in the catalog, so left out: ${unknown.join(', ')}. Use the ids exactly as search_skills gives them.` : '',
      ].filter(Boolean).join(' '),
    };
  }

  /** The owner's own changes to a draft. */
  edit(id: string, body: Record<string, unknown>): Hire | undefined {
    const cur = this.store.get('hire', id);
    if (!cur || cur.status !== 'draft') return undefined;
    const target = cur.staffId ? this.store.get('staff', cur.staffId) : undefined;
    return this.store.update('hire', id, (h) => {
      for (const [k, max] of [['name', 60], ['role', 60], ['about', 600], ['profile', 8000]] as const) {
        const v = text(body[k], max);
        if (v !== undefined) h[k] = v;
      }
      if (body.color === null || body.color === '') h.color = null;
      else if (typeof body.color === 'string' && staffColor(body.color)) h.color = body.color;
      const letter = text(body.letter, 2);
      if (letter) h.letter = letter[0]!.toUpperCase();
      else if (text(body.name, 60) && !body.letter) h.letter = h.name[0]?.toUpperCase() ?? h.letter;
      if (body.authority && typeof body.authority === 'object') {
        // Start from nothing so the owner can also take a level away.
        h.authority = cleanAuthority(body.authority, {}, { chief: !!target?.isChief });
      }
      if (Array.isArray(body.skills)) {
        const next: HireSkill[] = [];
        for (const raw of body.skills as any[]) {
          const ref = String(raw?.ref ?? '');
          const had = h.skills.find((s) => s.ref === ref);
          const found = this.catalog.get(ref);
          if (!had && !found) continue;
          if (next.some((s) => s.ref === ref)) continue;
          next.push({
            ...(had ?? { ref, name: found!.name, description: found!.description, source: found!.source, plugin: found!.plugin, scripts: found!.scripts, why: '' , take: true }),
            take: raw?.take !== false,
          });
        }
        h.skills = next;
      }
      h.updatedAt = Date.now();
    });
  }

  drop(id: string): Hire | undefined {
    const cur = this.store.get('hire', id);
    if (!cur || cur.status !== 'draft') return undefined;
    return this.store.update('hire', id, (h) => { h.status = 'dropped'; h.decidedAt = Date.now(); h.updatedAt = Date.now(); });
  }

  /** The owner signs: the person is created (or set up again) and the chosen skills are installed. */
  sign(id: string): { hire: Hire; staff: Staff } | { error: string } {
    const cur = this.store.get('hire', id);
    if (!cur) return { error: 'No such draft.' };
    if (cur.status !== 'draft') return { error: 'That draft was already decided.' };
    if (!cur.name.trim() || !cur.role.trim()) return { error: 'A member of staff needs a name and a role.' };
    const clash = this.store.list('staff').find((s) => !s.retired && s.id !== cur.staffId && s.name.toLowerCase() === cur.name.trim().toLowerCase());
    if (clash) return { error: `There is already someone called ${clash.name}. Staff hand work to each other by name, so names have to differ.` };

    let staff: Staff | undefined;
    if (cur.staffId) {
      const before = this.store.get('staff', cur.staffId);
      if (!before || before.retired) return { error: 'That member of staff is no longer here.' };
      staff = this.store.update('staff', cur.staffId, (s) => {
        s.name = cur.name.trim();
        s.letter = cur.letter || s.letter;
        s.color = cur.color ?? null;
        s.role = cur.role.trim();
        s.about = cur.about;
        s.instructions = cur.profile;
        s.authority = cleanAuthority(cur.authority, {}, { chief: s.isChief });
      });
    } else {
      staff = this.store.put('staff', {
        id: newId('staff'), name: cur.name.trim(), letter: cur.letter || cur.name.trim()[0]!.toUpperCase(), color: cur.color ?? null, role: cur.role.trim(),
        about: cur.about, instructions: cur.profile, skills: [], isChief: false, model: null, configDir: null,
        authority: cleanAuthority(cur.authority, {}), record: { asWritten: 0, edited: 0, declined: 0 },
        order: this.store.list('staff').length, hiredAt: Date.now(), retired: false, unread: 0, lastLine: null,
      });
    }
    if (!staff) return { error: 'Could not save the member of staff.' };
    this.ensureHome(staff);

    const problems: string[] = [];
    let installed = 0;
    for (const pick of cur.skills.filter((s) => s.take)) {
      try { this.skills.install(staff.id, pick.ref); installed += 1; } catch (e) { problems.push(`${pick.name}: ${(e as Error).message}`); }
    }

    const hire = this.store.update('hire', id, (h) => {
      h.status = 'hired';
      h.decidedAt = Date.now();
      h.updatedAt = Date.now();
      h.resultStaffId = staff!.id;
      if (problems.length) h.problems = problems;
    })!;
    const line = `${cur.staffId ? 'Set up again' : 'Hired'} as ${staff.role}${installed ? `, with ${installed} skill${installed === 1 ? '' : 's'} installed` : ''}.`;
    this.store.appendRow(staff.id, { type: 'note', tone: 'info', text: line });
    for (const p of problems) this.store.appendRow(staff.id, { type: 'note', tone: 'warn', text: `Could not install ${p}` });
    return { hire, staff: this.store.get('staff', staff.id)! };
  }
}
