import { useEffect, useMemo, useState } from 'react';
import { ACTION_CLASSES, LEVEL_SHORT, recordTotal } from '@shared/contract.ts';
import type { Level, Staff, UsageSummary } from '@shared/contract.ts';
import { BackIcon, Bubble, ColorPicker, Hatch, LevelMarks, LiveMark, Sheet, waitWords } from '../components/bits.tsx';
import { ArtifactsBlock, ArtifactViewer, useArtifactParam } from '../components/Artifacts.tsx';
import { Composer, Transcript } from '../components/Conversation.tsx';
import { ContextLine } from '../components/Usage.tsx';
import { pickLevel } from '../components/LevelPicker.tsx';
import { clock, isoDay, plural, when } from '../lib/format.ts';
import { back, Link } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useHireDrafts, useIsPhone, useNow, useStore, useWorkList } from '../sync/store.ts';
import { WORK_STATE_LABEL, workState } from './Work.tsx';

// ------------------------------------------------------------------- details

export function StaffDetails({ staff }: { staff: Staff }) {
  const dutyMap = useStore((s) => s.duties);
  const slips = useStore((s) => s.slips);
  const t = useNow(60_000);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let live = true;
    void api.usage().then((u) => live && setUsage(u));
    return () => {
      live = false;
    };
  }, [staff.id]);

  const duties = useMemo(() => Object.values(dutyMap).filter((d) => d.staffId === staff.id), [dutyMap, staff.id]);
  const workOn = useStore((s) => s.workOn);
  const allWork = useWorkList();
  const openWork = useMemo(() => allWork.filter((w) => w.staffId === staff.id && w.status !== 'closed'), [allWork, staff.id]);
  const proposed = new Set<string>();
  for (const id in slips) {
    const s = slips[id]!;
    if (s.status === 'pending' && s.promotion?.staffId === staff.id) proposed.add(s.promotion.classId);
  }
  const classes = ACTION_CLASSES.filter((c) => c.locked || (staff.authority[c.id] ?? 0) > 0);
  const r = staff.record;
  const total = recordTotal(r);
  const turns = usage?.turns?.[staff.id];
  const demo = useStore((s) => s.settings?.engine === 'demo');

  return (
    <>
      <Link to={`/settings#staff-${staff.id}`} className="staff-edit">
        <span className="grow">
          <b>Edit {staff.name}</b>
          <small>Name, role, profile, model, duties and skills</small>
        </span>
        <span className="btn btn-line btn-sm" aria-hidden="true">
          Edit
        </span>
      </Link>

      <section className="aside-block" style={{ gap: 8 }}>
        <div className="aside-head" style={{ minHeight: 24 }}>
          <h2 className="aside-title">Bubble color</h2>
        </div>
        <ColorPicker value={staff.color ?? null} letter={staff.letter} onChange={(color) => void api.saveStaff(staff.id, { color })} />
      </section>

      <section className="aside-block">
        <div className="aside-head" style={{ paddingTop: 8 }}>
          <h2 className="aside-title">Duties</h2>
          <Link to={`/settings#staff-${staff.id}`} className="link">
            Change
          </Link>
        </div>
        {duties.length === 0 && <p className="empty" style={{ fontSize: 14 }}>No standing duties yet. Add one in Settings and {staff.name} will keep to it.</p>}
        {duties.map((d) => {
          const state = d.held && d.enabled ? `Held ${when(d.held.at, t)}` : d.note ?? (d.lastDoneAt && isoDay(d.lastDoneAt) === isoDay(t) ? `Done ${clock(d.lastDoneAt)}` : d.nextDueAt ? `Next ${when(d.nextDueAt, t)}` : d.lastDoneAt ? `Done ${when(d.lastDoneAt, t)}` : d.enabled ? '' : 'Paused');
          return (
            <div key={d.id} className="duty">
              <div className="grow">
                <div className="duty-title">{d.title}</div>
                <div className="duty-cadence">{d.enabled ? d.cadence : `${d.cadence}, paused`}</div>
              </div>
              <div className={`duty-state${d.attention || (d.held && d.enabled) ? ' red' : ''}`} title={d.held && d.enabled ? `Not run: ${d.held.why}.` : undefined}>{state}</div>
            </div>
          );
        })}
      </section>

      {(workOn || openWork.length > 0) && (
        <section className="aside-block">
          <div className="aside-head">
            <h2 className="aside-title">Open work</h2>
            <Link to="/work" className="link">
              All work
            </Link>
          </div>
          {openWork.length === 0 && <p className="empty" style={{ fontSize: 14 }}>Nothing on the work list for {staff.name}.</p>}
          {openWork.map((w) => (
            <Link key={w.id} to={`/work#${w.id}`} className="duty">
              <div className="grow">
                <div className="duty-title">{w.title}</div>
              </div>
              <div className="duty-state">{WORK_STATE_LABEL[workState(w)]}</div>
            </Link>
          ))}
        </section>
      )}

      <ArtifactsBlock staff={staff} />

      <section className="aside-block">
        <div className="aside-head">
          <h2 className="aside-title">Authority</h2>
          <Link to="/staff" className="link">
            Everyone
          </Link>
        </div>
        <p className="aside-hint">Tap a line to change what {staff.name} may do.</p>
        {classes.map((c) => {
          const level = (staff.authority[c.id] ?? 0) as Level;
          if (c.locked) {
            return (
              <div key={c.id} className="auth-row">
                <span className="grow">{c.label}</span>
                <span className="auth-level never">Never</span>
                <Hatch width={49} />
              </div>
            );
          }
          const fixed = c.chiefOnly && !staff.isChief;
          return (
            <button key={c.id} className="auth-row" disabled={fixed} onClick={(e) => pickLevel(e.currentTarget, staff.id, c.id)} aria-label={`${c.label}: ${LEVEL_SHORT[level]}. Change`}>
              <span className="grow">{c.label}</span>
              <span className="auth-level">{LEVEL_SHORT[level]}</span>
              <LevelMarks level={level} proposed={proposed.has(c.id) && level < 4} />
            </button>
          );
        })}
      </section>

      <section className="aside-block" style={{ gap: 10 }}>
        <div className="aside-head" style={{ minHeight: 24 }}>
          <h2 className="aside-title">Record, last 30 days</h2>
          <span className="aside-meta">{plural(total, 'slip')}</span>
        </div>
        {total === 0 ? (
          <p className="empty" style={{ fontSize: 14 }}>No slips decided yet. The record builds as you sign, edit and decline.</p>
        ) : (
          <>
            <div className="record-bar" role="img" aria-label={`${r.asWritten} signed as written, ${r.edited} edited, ${r.declined} declined`}>
              {r.asWritten > 0 && <i style={{ flex: r.asWritten, background: 'var(--blue)' }} />}
              {r.edited > 0 && <i style={{ flex: r.edited, background: 'var(--ink)' }} />}
              {r.declined > 0 && <i style={{ flex: r.declined, background: 'var(--red)' }} />}
            </div>
            <div className="record-legend">
              <span>
                <i style={{ background: 'var(--blue)' }} />
                {r.asWritten} signed as written
              </span>
              {r.edited > 0 && (
                <span>
                  <i style={{ background: 'var(--ink)' }} />
                  {r.edited} edited
                </span>
              )}
              {r.declined > 0 && (
                <span>
                  <i style={{ background: 'var(--red)' }} />
                  {r.declined} declined
                </span>
              )}
            </div>
          </>
        )}
      </section>

      <section className="runs">
        <h2 className="aside-title">Runs on</h2>
        <p>
          {demo ? 'The demo engine. Replies are scripted and no Claude usage is spent.' : `${staff.model ? `Claude, model ${staff.model}` : 'Claude, your account’s usual model'}${staff.effort ? `, ${staff.effort === 'xhigh' ? 'extra high' : staff.effort === 'max' ? 'maximum' : staff.effort} effort` : ''}${staff.configDir ? `, account folder ${staff.configDir}` : ', on your own Claude plan'}`}
        </p>
        {turns !== undefined && <small>{plural(turns, 'turn')} in the last seven days.</small>}
      </section>
    </>
  );
}
// -------------------------------------------------------------------- thread

/**
 * In the chief of staff's thread, a hire drafted there: the draft is kept on the hiring desk, so
 * say so and open it. Without this a draft made in the ordinary thread could not be found.
 */
function DraftBar() {
  const drafts = useHireDrafts();
  if (drafts.length === 0) return null;
  const first = drafts[0]!;
  const role = (h: { role: string }) => `${h.role.charAt(0).toLowerCase()}${h.role.slice(1)}`;
  return (
    <Link to={`/hire?draft=${encodeURIComponent(first.id)}`} className="thread-pointer">
      <span className="grow">
        <b>{drafts.length === 1 ? 'A hire is waiting for you' : `${drafts.length} hires are waiting for you`}:</b>{' '}
        {drafts.map((h) => `${h.name || 'unnamed'}, ${role(h)}`).join('; ')}.
      </span>
      <span className="link">Open the draft</span>
    </Link>
  );
}

export function Thread({ staffId }: { staffId: string }) {
  const staff = useStore((s) => s.staff[staffId]);
  const running = useStore((s) => !!s.live[staffId]?.running);
  const activity = useStore((s) => s.live[staffId]?.activity ?? null);
  const waitKind = useStore((s) => { const id = s.live[staffId]?.waitingSlipId; return id ? s.slips[id]?.kind ?? 'action' : null; });
  const [details, setDetails] = useState(false);
  const phone = useIsPhone();
  const artifact = useArtifactParam();

  if (!staff) {
    return (
      <div className="page">
        <h1 className="page-title">Nobody by that name works here</h1>
        <p className="page-lede">
          <Link to="/staff" className="link">
            See who does
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="thread">
      <div className="thread-main">
        <header className="thread-head">
          <button className="phone-only btn" onClick={() => back('/')} aria-label="Back" style={{ padding: '0 6px 0 0', height: 40 }}>
            <BackIcon />
          </button>
          <Bubble staff={staff} size={40} />
          <div className="grow">
            <h1 className="thread-name">{staff.name}</h1>
            <p className="thread-sub">
              {running && <LiveMark waiting={!!waitKind} />}
              {staff.role}
              {running ? (waitKind ? <span className="red">. {waitWords(waitKind)}.</span> : `. ${activity ?? 'Working'}.`) : ''}
            </p>
            <p className="thread-sub phone-only">
              <ContextLine staff={staff} />
            </p>
          </div>
          <button className="btn btn-soft phone-only" onClick={() => setDetails(true)}>
            Details
          </button>
          <button className="btn btn-soft desk-only" onClick={() => void api.newConversation(staff.id)} title="Start a fresh conversation. Notes and files are kept.">
            New conversation
          </button>
        </header>

        {staff.isChief && <DraftBar />}

        <Transcript
          staff={staff}
          empty={
            <>
              <b>Nothing here yet.</b> Write to {staff.name} below to hand over a job. {staff.about}
            </>
          }
        />

        <Composer staff={staff} />
      </div>

      <aside className="thread-aside" aria-label="Details">
        <h2 className="aside-heading">Details</h2>
        <StaffDetails staff={staff} />
      </aside>

      {details && phone && (
        <Sheet title={`${staff.name}, ${staff.role.charAt(0).toLowerCase()}${staff.role.slice(1)}`} onClose={() => setDetails(false)}>
          <StaffDetails staff={staff} />
        </Sheet>
      )}

      {artifact && <ArtifactViewer staffId={staff.id} id={artifact.id} />}
    </div>
  );
}
