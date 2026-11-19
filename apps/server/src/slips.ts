import type { Level, Slip, SlipCheck, Staff } from '../../../shared/contract.ts';
import { actionClass, LEVEL_SHORT } from '../../../shared/contract.ts';
import { LESSONS_HEADING } from './prompt.ts';
import { newId, type Store } from './store.ts';

/** One line, no list marker or quotes, or null when there is no rule. */
function tidyRule(raw: string | null | undefined): string | null {
  const line = String(raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const text = line.replace(/^[-*•\d.)\s]+/, '').replace(/^["“']+|["”']+$/g, '').replace(/\s+/g, ' ').trim();
  if (!text || /^none\b/i.test(text) || text.length < 8) return null;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

/**
 * Slips: everything that waits for the owner.
 *
 * A slip is created by the authority gate (an action that needs a signature), by a staff member
 * (a question, or something to review), or by the record (a promotion). Signing does not take
 * effect at once: the slip sits in "signing" for a few seconds so it can be undone.
 */

export type SlipResult =
  | { status: 'signed'; text?: string; answer?: string }
  | { status: 'declined'; reason?: string }
  | { status: 'expired' };

interface SlipPrivate {
  id: string;
  /** A running turn is blocked on this slip; if the server restarts it can never be honoured. */
  needsWaiter: boolean;
  editedText?: string;
  /** The draft as it was prepared, kept when the owner changes it, so the two can be compared. */
  originalText?: string;
}

/** One correction by the owner: a draft changed before signing, or a slip declined with a reason. */
export interface Correction { slip: Slip; before: string; after?: string; reason?: string }

export interface SlipsDeps {
  store: Store;
  /** Ask the chief of staff to look at a slip. Resolves to a one-line verdict. */
  check?: (slip: Slip, chief: Staff) => Promise<{ ok: boolean; note: string }>;
  /** Called when a new slip needs the owner (for notifications). */
  onNeedsOwner?: (slip: Slip) => void;
  /** Ask whether a correction holds a standing rule. Resolves to the rule in one sentence, or null. */
  learn?: (c: Correction, staff: Staff) => Promise<string | null>;
}

const DAY = 86_400_000;
/** How many slips in a row, signed as written, before the record proposes a promotion. */
export const PROMOTION_STREAK = 8;
/** No more than this many proposed rules wait for one person at a time. */
export const LESSONS_WAITING = 3;

export class Slips {
  private waiters = new Map<string, (r: SlipResult) => void>();
  private timers = new Map<string, NodeJS.Timeout>();
  private deps: SlipsDeps;

  constructor(deps: SlipsDeps) {
    this.deps = deps;
  }

  private get store() { return this.deps.store; }

  /** After a restart nothing is waiting any more: close slips that depended on a running turn. */
  recover() {
    for (const slip of this.store.list('slip')) {
      const priv = this.store.getPrivate<SlipPrivate>('_slipx', slip.id);
      if (slip.status === 'signing') this.commit(slip.id);
      else if (slip.status === 'pending' && priv?.needsWaiter) this.close(slip.id, 'expired');
    }
  }

  create(
    input: Pick<Slip, 'kind' | 'staffId' | 'title' | 'detail' | 'origin'> & Partial<Pick<Slip, 'actionClass' | 'draft' | 'options' | 'promotion' | 'lesson' | 'batch'>>,
    opts: { needsWaiter: boolean; addRow?: boolean } = { needsWaiter: false },
  ): Slip {
    const staff = this.store.get('staff', input.staffId);
    const chief = this.store.list('staff').find((s) => s.isChief && !s.retired);
    const settings = this.store.get('settings', 'settings')!;
    const wantsCheck = settings.checkSlips && !!this.deps.check && !!chief && chief.id !== input.staffId && (input.kind === 'action' || input.kind === 'review');
    const check: SlipCheck | undefined = input.kind === 'promotion' || input.kind === 'question' || input.kind === 'lesson'
      ? undefined
      : wantsCheck ? { by: chief!.id, state: 'checking' } : { by: chief?.id ?? input.staffId, state: 'skipped' };

    const slip = this.store.transact(() => {
      const created = this.store.put('slip', {
        id: newId('slip'), ...input, check, status: 'pending', createdAt: Date.now(),
      } as Omit<Slip, 'rev'>);
      this.store.putPrivate<SlipPrivate>('_slipx', { id: created.id, needsWaiter: opts.needsWaiter });
      if (opts.addRow !== false && staff) this.store.appendRow(staff.id, { type: 'slip', slipId: created.id });
      return created;
    });

    if (wantsCheck) {
      this.deps.check!(slip, chief!)
        .then((v) => this.setCheck(slip.id, { by: chief!.id, state: v.ok ? 'ok' : 'concern', note: v.note || undefined, at: Date.now() }))
        .catch((e) => {
          console.error('[slips] check failed', e);
          this.setCheck(slip.id, { by: chief!.id, state: 'skipped', note: 'The check could not run.' });
        });
    }
    // A proposed rule waits on the Desk; it is not worth interrupting the owner for.
    if (slip.kind !== 'lesson') this.deps.onNeedsOwner?.(slip);
    return slip;
  }

  private setCheck(id: string, check: SlipCheck) {
    this.store.update('slip', id, (s) => { s.check = check; });
  }

  /** Block until the slip is decided. Aborting (the turn was stopped) expires it. */
  wait(id: string, signal?: AbortSignal): Promise<SlipResult> {
    return new Promise((resolve) => {
      const slip = this.store.get('slip', id);
      if (!slip) return resolve({ status: 'expired' });
      if (slip.status === 'signed') return resolve({ status: 'signed', answer: slip.answer });
      if (slip.status === 'declined') return resolve({ status: 'declined', reason: slip.declineReason });
      if (slip.status === 'expired') return resolve({ status: 'expired' });
      this.waiters.set(id, resolve);
      signal?.addEventListener('abort', () => {
        if (this.waiters.get(id) === resolve) this.close(id, 'expired');
      }, { once: true });
    });
  }

  /** Sign a slip. For a batch, `items` names the items signed (all of them when left out). */
  sign(id: string, text?: string, items?: number[]): Slip | { error: string } {
    const slip = this.store.get('slip', id);
    if (!slip) return { error: 'No such slip.' };
    if (slip.status !== 'pending') return { error: 'This slip is no longer waiting.' };
    if (slip.kind === 'question') return { error: 'Answer a question rather than signing it.' };
    const settings = this.store.get('settings', 'settings')!;
    let approved: number[] | undefined;
    if (slip.batch) {
      const all = slip.batch.items.map((_, i) => i);
      approved = items === undefined ? all : [...new Set(items)].filter((i) => Number.isInteger(i) && i >= 0 && i < all.length).sort((a, b) => a - b);
      if (!approved.length) return { error: 'Tick at least one item, or decline the whole set.' };
    }
    const unticked = !!approved && approved.length < slip.batch!.items.length;
    const textEdited = text !== undefined && slip.draft?.editable === true && text !== slip.draft.text;
    const edited = unticked || textEdited;
    if (textEdited) {
      const priv = this.store.getPrivate<SlipPrivate>('_slipx', id) ?? { id, needsWaiter: false };
      this.store.putPrivate<SlipPrivate>('_slipx', { ...priv, editedText: text, originalText: priv.originalText ?? slip.draft!.text });
    }
    const wait = Math.max(0, settings.undoSeconds) * 1000;
    const next = this.store.update('slip', id, (s) => {
      s.status = 'signing';
      s.commitAt = Date.now() + wait;
      s.edited = edited || undefined;
      if (textEdited && s.draft) s.draft = { ...s.draft, text: text! };
      if (approved && s.batch) s.batch = { ...s.batch, approved };
    })!;
    this.timers.set(id, setTimeout(() => this.commit(id), wait));
    return next;
  }

  undo(id: string): Slip | { error: string } {
    const slip = this.store.get('slip', id);
    if (!slip || slip.status !== 'signing') return { error: 'It has already gone ahead.' };
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    return this.store.update('slip', id, (s) => { s.status = 'pending'; s.commitAt = undefined; if (s.batch) { s.batch = { classId: s.batch.classId, items: s.batch.items }; s.edited = undefined; } })!;
  }

  private commit(id: string) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const slip = this.store.get('slip', id);
    if (!slip || slip.status !== 'signing') return;
    const priv = this.store.getPrivate<SlipPrivate>('_slipx', id);
    this.store.transact(() => {
      const signed = this.store.update('slip', id, (s) => { s.status = 'signed'; s.decidedAt = Date.now(); s.commitAt = undefined; })!;
      if (signed.kind === 'promotion' && signed.promotion) this.applyPromotion(signed);
      if (signed.kind === 'lesson' && signed.lesson) this.applyLesson(signed);
      this.refreshRecord(signed.staffId);
    });
    this.resolve(id, { status: 'signed', text: priv?.editedText });
    this.maybeProposePromotion(id);
    const after = this.store.get('slip', id);
    if (after?.edited && priv?.originalText !== undefined) this.maybeLearn({ slip: after, before: priv.originalText, after: after.draft?.text ?? '' });
  }

  decline(id: string, reason?: string): Slip | { error: string } {
    const slip = this.store.get('slip', id);
    if (!slip || (slip.status !== 'pending' && slip.status !== 'signing')) return { error: 'This slip is no longer waiting.' };
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const next = this.store.transact(() => {
      const d = this.store.update('slip', id, (s) => { s.status = 'declined'; s.decidedAt = Date.now(); s.commitAt = undefined; s.declineReason = reason?.trim() || undefined; })!;
      this.refreshRecord(d.staffId);
      return d;
    });
    this.resolve(id, { status: 'declined', reason: next.declineReason });
    if (next.declineReason) this.maybeLearn({ slip: next, before: next.draft?.text ?? next.detail, reason: next.declineReason });
    return next;
  }

  answer(id: string, answer: string): Slip | { error: string } {
    const slip = this.store.get('slip', id);
    if (!slip || slip.status !== 'pending') return { error: 'This question is no longer open.' };
    if (slip.kind !== 'question') return { error: 'Only questions take an answer.' };
    const next = this.store.update('slip', id, (s) => { s.status = 'signed'; s.decidedAt = Date.now(); s.answer = answer.trim(); })!;
    this.resolve(id, { status: 'signed', answer: next.answer });
    return next;
  }

  /** Expire every open slip a staff member is waiting on (their turn was stopped). */
  expireFor(staffId: string) {
    for (const slip of this.store.list('slip')) {
      if (slip.staffId === staffId && slip.status === 'pending' && this.waiters.has(slip.id)) this.close(slip.id, 'expired');
    }
  }

  private close(id: string, status: 'expired') {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const slip = this.store.get('slip', id);
    if (slip && (slip.status === 'pending' || slip.status === 'signing')) {
      this.store.update('slip', id, (s) => { s.status = status; s.decidedAt = Date.now(); s.commitAt = undefined; });
    }
    this.resolve(id, { status });
  }

  private resolve(id: string, result: SlipResult) {
    const waiter = this.waiters.get(id);
    this.waiters.delete(id);
    waiter?.(result);
  }

  // ---------------------------------------------------------------- record

  /** Recount a staff member's last 30 days of decided slips. */
  refreshRecord(staffId: string) {
    const since = Date.now() - 30 * DAY;
    const record = { asWritten: 0, edited: 0, declined: 0 };
    for (const s of this.store.list('slip')) {
      if (s.staffId !== staffId || (s.kind !== 'action' && s.kind !== 'review') || (s.decidedAt ?? 0) < since) continue;
      if (s.status === 'declined') record.declined += 1;
      else if (s.status === 'signed') record[s.edited ? 'edited' : 'asWritten'] += 1;
    }
    const staff = this.store.get('staff', staffId);
    if (staff && JSON.stringify(staff.record) !== JSON.stringify(record)) this.store.update('staff', staffId, (s) => { s.record = record; });
  }

  // --------------------------------------------------------------- lessons

  /**
   * The owner corrected a piece of work. If the correction holds a standing rule, propose adding it
   * to that person's profile. The proposal is a slip like any other: nothing is learned unsigned.
   */
  private maybeLearn(c: Correction) {
    const { learn } = this.deps;
    if (!learn || (c.slip.kind !== 'action' && c.slip.kind !== 'review')) return;
    const staff = this.store.get('staff', c.slip.staffId);
    if (!staff || staff.retired) return;
    const waiting = () => this.store.list('slip').filter((s) => s.kind === 'lesson' && s.lesson?.staffId === staff.id && (s.status === 'pending' || s.status === 'signing'));
    if (waiting().length >= LESSONS_WAITING) return;
    learn(c, staff).then((rule) => {
      const text = tidyRule(rule);
      const now = this.store.get('staff', staff.id);
      if (!text || !now || now.retired) return;
      const same = (a: string) => a.trim().toLowerCase() === text.toLowerCase();
      if (now.instructions.toLowerCase().includes(text.toLowerCase()) || waiting().some((s) => same(s.draft?.text ?? '')) || waiting().length >= LESSONS_WAITING) return;
      const from = c.reason !== undefined ? 'decline' : 'edit';
      this.create({
        kind: 'lesson',
        staffId: staff.id,
        title: `A rule for ${staff.name}, from ${from === 'edit' ? 'your edit' : 'what you declined'}`,
        detail: from === 'edit'
          ? `You changed “${c.slip.title}” before signing it. If this is how you always want it, sign and it goes into ${staff.name}’s profile.`
          : `You declined “${c.slip.title}” and said why. If that holds in general, sign and it goes into ${staff.name}’s profile.`,
        origin: { trigger: from === 'edit' ? `Your edit of “${c.slip.title}”` : `Your reason for declining “${c.slip.title}”`, read: c.slip.origin.read },
        draft: { meta: [], text, editable: true },
        lesson: { staffId: staff.id, from, about: c.slip.title },
      }, { needsWaiter: false, addRow: false });
    }).catch((e) => console.error('[slips] could not draw a lesson', e));
  }

  /** Add a signed rule to the person's profile, under its own heading, as the last thing in it. */
  private applyLesson(slip: Slip) {
    const rule = tidyRule(slip.draft?.text);
    if (!rule) return;
    this.store.update('staff', slip.lesson!.staffId, (s) => {
      const body = s.instructions.trimEnd();
      s.instructions = body.includes(LESSONS_HEADING) ? `${body}\n- ${rule}` : `${body}${body ? '\n\n' : ''}${LESSONS_HEADING}\n- ${rule}`;
    });
  }

  private applyPromotion(slip: Slip) {
    const p = slip.promotion!;
    this.store.update('staff', p.staffId, (s) => { s.authority = { ...s.authority, [p.classId]: p.to }; });
  }

  /**
   * After a slip is signed as written: if this person's recent slips of the same kind were all
   * signed unchanged and they still have to ask, propose that they stop asking.
   * The proposal is rule-based and filed under the chief of staff's name.
   */
  private maybeProposePromotion(signedId: string) {
    const slip = this.store.get('slip', signedId);
    if (!slip || slip.kind !== 'action' || !slip.actionClass || slip.edited) return;
    const staff = this.store.get('staff', slip.staffId);
    const def = actionClass(slip.actionClass);
    if (!staff || !def || def.locked || (staff.authority[slip.actionClass] ?? 0) !== 3) return;
    // A web page only waits for a signature because of what was read first. No level changes that.
    if (slip.actionClass === 'web.read') return;
    const all = this.store.list('slip');
    const same = all
      .filter((s) => s.staffId === staff.id && s.kind === 'action' && s.actionClass === slip.actionClass && (s.status === 'signed' || s.status === 'declined'))
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
      .slice(0, PROMOTION_STREAK);
    if (same.length < PROMOTION_STREAK || same.some((s) => s.status !== 'signed' || s.edited)) return;
    const recent = all.find((s) => s.kind === 'promotion' && s.promotion?.staffId === staff.id && s.promotion.classId === slip.actionClass
      && (s.status === 'pending' || s.status === 'signing' || (s.status === 'declined' && (s.decidedAt ?? 0) > Date.now() - 14 * DAY)));
    if (recent) return;
    const chief = this.store.list('staff').find((s) => s.isChief && !s.retired) ?? staff;
    const from: Level = 3;
    const to: Level = 4;
    this.create({
      kind: 'promotion',
      staffId: chief.id,
      title: `Promote ${staff.name}: ${def.label.toLowerCase()} without asking`,
      detail: `You signed ${staff.name}’s last ${PROMOTION_STREAK} as written. This moves ${staff.name} from “${LEVEL_SHORT[from]}” to “${LEVEL_SHORT[to]}” for this one kind of work. You can take it back on the Staff page.`,
      origin: { trigger: 'From the record', read: [] },
      actionClass: slip.actionClass,
      promotion: { staffId: staff.id, classId: slip.actionClass, from, to, record: `${PROMOTION_STREAK} of ${PROMOTION_STREAK}` },
    }, { needsWaiter: false, addRow: false });
  }
}
