import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { actionClass } from '@shared/contract.ts';
import type { Slip, Staff } from '@shared/contract.ts';
import { clock } from '../lib/format.ts';
import { api } from '../sync/client.ts';
import { confirmSignature, haptic } from '../lib/native.ts';
import { useIsPhone, useNow, useStore } from '../sync/store.ts';
import { Bubble, Check } from './bits.tsx';
import { Signature } from './Signature.tsx';

/** Slips signed on this device in this sitting: their signature is written out once. */
const justSigned = new Set<string>();

function signLabel(slip: Slip, taught?: Staff): string {
  if (slip.kind === 'lesson') return taught ? `Sign into ${taught.name}’s profile` : 'Sign into the profile';
  if (slip.actionClass?.startsWith('mail.')) return 'Sign and send';
  return 'Sign';
}

function ruleLine(slip: Slip, prepared: Staff | undefined): string | null {
  if (slip.kind === 'promotion') return 'Signing changes what this person may do. You can take it back at any time.';
  if (slip.kind === 'lesson') return 'Signing adds this line to the profile. You can change or remove it in Settings.';
  if (slip.kind === 'review') return prepared ? `${prepared.name} asked you to look at this before going further.` : null;
  const cls = slip.actionClass ? actionClass(slip.actionClass) : undefined;
  if (!cls || !prepared) return null;
  if (cls.id.startsWith('mail.')) return `${prepared.name} may draft mail. Sending needs you.`;
  return `${prepared.name} asks first: ${cls.label.charAt(0).toLowerCase()}${cls.label.slice(1)}.`;
}

function Who({ staff, concern }: { staff: Staff | undefined; concern?: boolean }) {
  return (
    <span className={`signoff-who${concern ? ' concern' : ''}`}>
      <Bubble staff={staff} size={20} working={false} />
      {staff?.name ?? 'Someone'}
    </span>
  );
}

function UndoBar({ slip, next }: { slip: Slip; next?: string | null }) {
  const t = useNow(200);
  const left = Math.max(0, Math.ceil(((slip.commitAt ?? t) - t) / 1000));
  const verb = slip.actionClass?.startsWith('mail.') ? 'Sending' : slip.kind === 'promotion' ? 'Taking effect' : 'Going ahead';
  return (
    <div className="slip-undo">
      <Check color="#1D3FE3" size={18} />
      <div className="slip-undo-text" aria-live="polite">
        {left > 0 ? `${verb} in ${left} second${left === 1 ? '' : 's'}` : `${verb} now`}
        {next ? <small>Next: {next}</small> : null}
      </div>
      <button className="btn btn-line" onClick={() => void api.undo(slip.id)} disabled={left <= 0}>
        Undo
      </button>
    </div>
  );
}

/**
 * One slip. `compact` is the form used inside a conversation: closed, it shows the title and the one
 * action, and opens to the full slip on demand.
 */
export const SlipCard = memo(function SlipCard({ slip, autoOpen = false, compact = false, focus = false }: { slip: Slip; autoOpen?: boolean; compact?: boolean; focus?: boolean }) {
  const prepared = useStore((s) => s.staff[slip.staffId]);
  const checker = useStore((s) => (slip.check ? s.staff[slip.check.by] : undefined));
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(slip.draft?.text ?? '');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  const phone = useIsPhone();
  const pending = slip.status === 'pending';
  const hasSig = (slip.status === 'signing' || slip.status === 'signed') && slip.kind !== 'question';
  // On a phone a slip opens as a full page to read and sign; in a list it stays closed.
  const sheet = phone && userOpen === true;
  const open = !phone && (userOpen ?? (!compact && (autoOpen || slip.status === 'signing')));
  const place = useStore((s) => {
    if (!sheet) return '';
    const waiting = Object.values(s.slips).filter((x) => x.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
    const at = waiting.findIndex((x) => x.id === slip.id);
    if (at >= 0) return `${at + 1} of ${waiting.length} to sign`;
    return waiting.length ? `${waiting.length} more to sign` : 'Nothing else to sign';
  });
  const next = useStore((s) => {
    if (!sheet) return null;
    const waiting = Object.values(s.slips).filter((x) => x.status === 'pending' && x.id !== slip.id).sort((a, b) => a.createdAt - b.createdAt);
    return waiting[0]?.title ?? null;
  });

  // The draft can change under us (the staff member revised it). Take the new one unless an edit
  // is open. Closing the editor keeps what was typed: it is signed as edited.
  const editingNow = useRef(editing);
  editingNow.current = editing;
  useEffect(() => {
    if (!editingNow.current) setText(slip.draft?.text ?? '');
  }, [slip.draft?.text]);
  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (!pending) {
      setEditing(false);
      setDeclining(false);
    }
  }, [pending]);
  // Once it has gone ahead or been declined, the slip folds away.
  const settled = slip.status === 'signed' || slip.status === 'declined' || slip.status === 'expired';
  const wasSettled = useRef(settled);
  useEffect(() => {
    if (settled && !wasSettled.current) setUserOpen(null);
    wasSettled.current = settled;
  }, [settled]);
  useEffect(() => {
    if (!sheet) return;
    const key = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setUserOpen(null);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [sheet]);

  // Arriving from a notification: bring this slip up to be read.
  useEffect(() => {
    if (!focus) return;
    setUserOpen(true);
    rootRef.current?.scrollIntoView({ block: 'center' });
  }, [focus]);

  const toggle = () => setUserOpen(phone ? true : !open);
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };
  const sign = async () => {
    // Inside the iPhone app a signature needs Face ID first.
    if (!(await confirmSignature(`Sign: ${slip.title}`))) return;
    justSigned.add(slip.id);
    const changed = slip.draft && text !== slip.draft.text ? text : undefined;
    setEditing(false);
    void api.sign(slip.id, changed);
  };

  const shown = open || sheet;
  const below = (
    <>
      {shown && slip.draft && (
        <div className="slip-draft">
          {slip.draft.meta.length > 0 && (
            <div className="slip-meta">
              {slip.draft.meta.map((m) => (
                <span key={m.label}>
                  {m.label} {m.value}
                </span>
              ))}
            </div>
          )}
          {editing ? (
            <textarea ref={editRef} className="slip-edit" value={text} onChange={(e) => setText(e.target.value)} aria-label="Draft" />
          ) : (
            <div className="slip-body">{pending ? text : slip.draft.text}</div>
          )}
        </div>
      )}

      {shown && pending && slip.kind === 'question' && (
        <div className="slip-options" style={{ paddingBottom: 12 }}>
          {(slip.options ?? []).map((o) => (
            <button key={o} className="btn btn-line" onClick={() => void api.answer(slip.id, o)}>
              {o}
            </button>
          ))}
        </div>
      )}

      {shown && pending && slip.kind !== 'question' && !declining && (
        <div className="slip-actions">
          <button className="btn btn-blue" onClick={() => void sign()}>
            {signLabel(slip, prepared)}
          </button>
          {slip.draft?.editable && (
            <button className="btn btn-line" onClick={() => setEditing(!editing)}>
              {editing ? 'Done editing' : slip.kind === 'lesson' ? 'Reword it' : 'Edit draft'}
            </button>
          )}
          <button className="btn btn-quiet" onClick={() => setDeclining(true)}>
            Decline
          </button>
          {ruleLine(slip, prepared) && <span className="slip-rule">{ruleLine(slip, prepared)}</span>}
        </div>
      )}

      {shown && pending && declining && (
        <form
          className="slip-actions"
          onSubmit={(e) => {
            e.preventDefault();
            haptic('warning');
            void api.decline(slip.id, reason.trim() || undefined);
          }}
        >
          <input className="input slip-reason" placeholder="Say why, if it helps (optional)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus aria-label="Reason for declining" />
          <button className="btn btn-ink" type="submit">
            Decline
          </button>
          <button className="btn btn-quiet" type="button" onClick={() => setDeclining(false)}>
            Keep it
          </button>
        </form>
      )}
    </>
  );

  const firstLabel = slip.kind === 'promotion' ? 'Proposed' : slip.kind === 'lesson' ? 'A rule for' : slip.kind === 'question' ? 'Asked' : 'Prepared';
  const concern = slip.check?.state === 'concern';
  const read = slip.origin.read;

  // `whole` is the full block; without it, only the last cell (used for settled slips in a conversation).
  const signoff = (whole: boolean) => (
        <div className="signoff">
          {whole && (
          <div className="signoff-cell">
            <span className="signoff-label">{firstLabel}</span>
            <Who staff={prepared} />
          </div>
          )}
          {!whole ? null : slip.kind === 'promotion' && slip.promotion ? (
            <div className="signoff-cell">
              <span className="signoff-label">Record</span>
              <span className="signoff-fig">{slip.promotion.record}</span>
            </div>
          ) : slip.kind === 'lesson' && slip.lesson ? (
            <div className="signoff-cell">
              <span className="signoff-label">Drawn from</span>
              <span className="signoff-quiet">{slip.lesson.from === 'edit' ? 'Your edit' : 'Your reason'}</span>
            </div>
          ) : slip.kind !== 'question' ? (
            <div className="signoff-cell">
              <span className="signoff-label">Checked</span>
              {!slip.check || slip.check.state === 'skipped' ? (
                <span className="signoff-quiet">Not checked</span>
              ) : slip.check.state === 'checking' ? (
                <span className="signoff-quiet">Checking</span>
              ) : (
                <Who staff={checker} concern={concern} />
              )}
            </div>
          ) : null}
          <div className="signoff-cell sig">
            {slip.status === 'pending' && (
              <>
                <span className="signoff-label">{slip.kind === 'question' ? 'Your answer' : 'Signed'}</span>
                <span className="signoff-line">
                  <b>×</b>
                  <i />
                </span>
              </>
            )}
            {(slip.status === 'signing' || slip.status === 'signed') && (
              <>
                <span className="signoff-label">
                  {slip.kind === 'question' ? 'Your answer' : 'Signed'}
                  {slip.decidedAt ? <time>{clock(slip.decidedAt)}</time> : null}
                </span>
                {slip.kind === 'question' ? <span className="signoff-answer">{slip.answer}</span> : <Signature animate={justSigned.has(slip.id) && slip.status === 'signing'} />}
              </>
            )}
            {slip.status === 'declined' && (
              <>
                <span className="signoff-label">
                  Declined{slip.decidedAt ? <time>{clock(slip.decidedAt)}</time> : null}
                </span>
                <span className="signoff-quiet">Not signed</span>
              </>
            )}
            {slip.status === 'expired' && (
              <>
                <span className="signoff-label">Lapsed</span>
                <span className="signoff-quiet">No longer needed</span>
              </>
            )}
          </div>
        </div>
  );

  return (
    <article ref={rootRef} className={`slip is-${slip.status}${open ? ' is-open' : ''}${hasSig ? ' has-sig' : ''}${compact && !open ? ' is-compact' : ''}`} aria-label={slip.title}>
      <div className="slip-head" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={onKey}>
        <div className="slip-text">
          <div className="slip-titleline">
            <span className="slip-mark">
              {pending ? <span className="dot" /> : hasSig || slip.status === 'signed' ? <Check color="#1D3FE3" size={10} /> : <span className="dot grey" style={{ width: 6, height: 6 }} />}
            </span>
            <h3 className="slip-title">{slip.title}</h3>
          </div>
          {slip.detail && <p className="slip-detail">{slip.detail}</p>}
          {open && (
            <p className="slip-origin">
              {slip.origin.trigger}
              {read.length > 0 && `. Outside material read on the way: ${read.join(', ')}`}
              {slip.edited && '. You changed the draft before signing'}
            </p>
          )}
          {concern && (
            <p className="slip-concern">
              {checker?.name ?? 'The checker'} has a concern{slip.check?.note ? `: ${slip.check.note}` : '.'}
            </p>
          )}
          {slip.status === 'declined' && slip.declineReason && open && <p className="slip-origin">You declined: {slip.declineReason}</p>}
        </div>

        {compact && !open && pending ? (
          <div className="signoff">
            <div className="signoff-cell act">
              <button
                className="btn btn-blue"
                onClick={(e) => {
                  e.stopPropagation();
                  if (slip.kind === 'question') setUserOpen(true);
                  else void sign();
                }}
              >
                {slip.kind === 'question' ? 'Answer' : slip.kind === 'lesson' ? 'Sign' : signLabel(slip)}
              </button>
            </div>
          </div>
        ) : (
          signoff(!compact || open)
        )}
      </div>

      {!sheet && below}

      {slip.status === 'signing' && !sheet && <UndoBar slip={slip} />}

      {sheet &&
        createPortal(
          <div className={`slip-page is-${slip.status}`} role="dialog" aria-modal="true" aria-label={slip.title}>
            <div className="slip-page-bar">
              <button className="slip-page-close" onClick={() => setUserOpen(null)} autoFocus>
                Close
              </button>
              <span>{place}</span>
            </div>
            <h2 className="slip-page-title">{slip.title}</h2>
            <p className="slip-page-lede">
              {slip.detail ? `${slip.detail} ` : ''}
              {slip.origin.trigger}
              {read.length > 0 && `. Outside material read on the way: ${read.join(', ')}`}
              {slip.edited && '. You changed the draft before signing'}.
            </p>
            {concern && (
              <p className="slip-concern" style={{ paddingLeft: 0 }}>
                {checker?.name ?? 'The checker'} has a concern{slip.check?.note ? `: ${slip.check.note}` : '.'}
              </p>
            )}
            {slip.status === 'declined' && slip.declineReason && <p className="slip-page-lede">You declined: {slip.declineReason}</p>}
            <div className="slip-page-body">{below}</div>
            <div className={`slip-page-signoff${hasSig ? ' has-sig' : ''}`}>{signoff(true)}</div>
            {slip.status === 'signing' && <UndoBar slip={slip} next={next} />}
          </div>,
          document.body,
        )}
    </article>
  );
});
