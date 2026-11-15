import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { VList, type VListHandle } from 'virtua';
import type { Row, Staff, Step } from '@shared/contract.ts';
import { bytes, clock, dur, durWords, isoDay, plural, shortDate } from '../lib/format.ts';
import { api, closeThread, loadOlder, openThread } from '../sync/client.ts';
import { toast, useIsPhone, useNow, useStore } from '../sync/store.ts';
import { Bubble, Check, Chevron, Me, PlusIcon } from './bits.tsx';
import { Markdown } from './Markdown.tsx';
import { SlipCard } from './Slip.tsx';

/**
 * A conversation with one member of staff: the transcript and the box to write in.
 * Used by a person's own thread and by the hiring desk.
 */

// ---------------------------------------------------------------------- rows

function Frame({ at, who, children, wide, timeLabel }: { at: number; who: ReactNode; children: ReactNode; wide?: boolean; timeLabel?: string }) {
  const today = isoDay(at) === isoDay(Date.now());
  return (
    <div className="trow">
      <time className="trow-time" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
        {timeLabel ?? (today ? clock(at) : shortDate(at).slice(4))}
      </time>
      <span className="trow-who">{who}</span>
      <div className={`trow-body${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  );
}

function StepLine({ step }: { step: Step }) {
  const bad = step.status === 'error' || step.status === 'declined';
  const took = step.endedAt ? dur(step.endedAt - step.startedAt) : '';
  return (
    <div className={`step${bad ? ' bad' : ''}${step.said ? ' said' : ''}`}>
      <span className="step-icon">
        {step.said ? null : step.status === 'done' ? <Check /> : step.status === 'running' ? <span className="step-run" /> : <span className="dot" />}
      </span>
      <span className="step-label">
        {step.said ?? step.label}
        {!step.said && step.detail && <small>{step.detail}</small>}
        {step.status === 'declined' && <small>You declined</small>}
      </span>
      {!step.said && <span className="step-time">{took}</span>}
    </div>
  );
}

function WorkLog({ body }: { body: Extract<Row['body'], { type: 'work' }> }) {
  const running = body.status === 'running';
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const t = useNow(running ? 1000 : 3_600_000);
  const real = body.steps.filter((s) => !s.said).length;
  const open = userOpen ?? (running || body.steps.length <= 6);
  const span = (body.endedAt ?? t) - body.startedAt;
  const head =
    body.status === 'running'
      ? `Working for ${durWords(span)}`
      : body.status === 'stopped'
        ? `Stopped after ${durWords(span)}`
        : body.status === 'error'
          ? `Ran into a problem after ${durWords(span)}`
          : `Worked for ${durWords(span)}`;
  return (
    <div className={`worklog${open ? '' : ' shut'}`}>
      <button className="worklog-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
        {head}
        {real > 0 ? `, ${plural(real, 'step')}` : ''}
        <Chevron />
      </button>
      {open && body.steps.map((s) => <StepLine key={s.id} step={s} />)}
      {open && body.error && <div className="step bad"><span className="step-icon"><span className="dot" /></span><span className="step-label">{body.error}</span></div>}
    </div>
  );
}

function SlipRow({ slipId }: { slipId: string }) {
  const slip = useStore((s) => s.slips[slipId]);
  if (!slip) return <p className="note-row">This slip is no longer on file.</p>;
  return <SlipCard slip={slip} compact />;
}

const RowView = memo(function RowView({ row, staff }: { row: Row; staff: Staff }) {
  const ownerName = useStore((s) => s.settings?.ownerName);
  const b = row.body;
  if (b.type === 'message') {
    if (b.from === 'owner') {
      return (
        <Frame at={row.at} who={<Me />}>
          <div className={`msg mine${row.id.startsWith('tmp:') ? ' pending' : ''}`}>
            {b.text}
            {b.files && b.files.length > 0 && (
              <ul className="msg-files" aria-label="Attached">
                {b.files.map((f, i) => (
                  <li key={i}>
                    {f.name} <span>{bytes(f.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Frame>
      );
    }
    const via = b.via ? (b.via.kind === 'duty' ? `Duty: ${b.via.name}` : b.via.kind === 'staff' ? `From ${b.via.name}` : b.via.kind === 'work' ? `Work from ${!b.via.staffId && b.via.name === ownerName ? 'you' : b.via.name}` : b.via.kind === 'drop' ? 'You left in Drop here' : `${b.via.name}, by iMessage`) : null;
    return (
      <Frame at={row.at} who={b.from === 'staff' ? <Bubble staff={staff} size={24} working={false} /> : null}>
        {via && <div className="msg-via">{via}</div>}
        <div className={`msg${b.from === 'system' ? ' muted' : ''}`}>
          <Markdown text={b.text} />
          {b.streaming && <span className="caret" aria-hidden="true" />}
        </div>
      </Frame>
    );
  }
  if (b.type === 'work') {
    return (
      <Frame at={row.at} who={<Bubble staff={staff} size={24} working={false} />}>
        <WorkLog body={b} />
      </Frame>
    );
  }
  if (b.type === 'slip') {
    return (
      <Frame at={row.at} who={<Bubble staff={staff} size={24} working={false} />} wide>
        <SlipRow slipId={b.slipId} />
      </Frame>
    );
  }
  return (
    <Frame at={row.at} who={null}>
      <p className={`note-row ${b.tone}`}>{b.text}</p>
    </Frame>
  );
});

function NowRow({ staff }: { staff: Staff }) {
  const live = useStore((s) => s.live[staff.id]);
  const t = useNow(1000);
  if (!live?.running) return null;
  return (
    <Frame at={t} timeLabel="Now" who={<Bubble staff={staff} size={24} working />}>
      <div className="now">
        <span className="hl">{live.activity ?? 'Working'}</span>
        {live.since && <span className="step-time">{dur(t - live.since)}</span>}
        {live.queued > 0 && <span className="step-time">{plural(live.queued, 'message')} waiting</span>}
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------- transcript

/** The rows of one thread, kept at the latest line unless the reader has scrolled away. */
export function Transcript({ staff, empty }: { staff: Staff; empty: ReactNode }) {
  const staffId = staff.id;
  const thread = useStore((s) => s.threads[staffId]);
  const running = useStore((s) => !!s.live[staffId]?.running);
  const activity = useStore((s) => s.live[staffId]?.activity ?? null);
  const list = useRef<VListHandle>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);

  useEffect(() => {
    openThread(staffId);
    stick.current = true;
    setAway(false);
    return () => closeThread(staffId);
  }, [staffId]);

  const rows = thread?.rows ?? [];
  const firstId = rows[0]?.id;
  const lastId = rows[rows.length - 1]?.id;
  const prevEnds = useRef<{ first?: string; last?: string }>({});
  // Rows were added above (earlier history): hold the view where it is.
  const shift = !!prevEnds.current.first && firstId !== prevEnds.current.first && lastId === prevEnds.current.last;
  useEffect(() => {
    prevEnds.current = { first: firstId, last: lastId };
  });

  const count = rows.length + (running ? 1 : 0);
  useLayoutEffect(() => {
    if (stick.current && count > 0) list.current?.scrollToIndex(count - 1, { align: 'end' });
  }, [rows, count, activity]);

  // Rows also grow after they are drawn (a slip opens, the keyboard comes up): keep the latest in view.
  const box = useRef<HTMLDivElement>(null);
  const countRef = useRef(count);
  countRef.current = count;
  const showEmpty = !!thread?.loaded && rows.length === 0 && !running;
  useEffect(() => {
    const host = box.current;
    if (!host || showEmpty || typeof ResizeObserver === 'undefined') return;
    const follow = () => {
      if (stick.current && countRef.current > 0) list.current?.scrollToIndex(countRef.current - 1, { align: 'end' });
    };
    const watch = new ResizeObserver(follow);
    watch.observe(host);
    const inner = host.querySelector('.transcript-list')?.firstElementChild;
    if (inner) watch.observe(inner);
    return () => watch.disconnect();
  }, [staffId, showEmpty]);

  const onScroll = (offset: number) => {
    const h = list.current;
    if (!h) return;
    const atBottom = offset + h.viewportSize >= h.scrollSize - 56;
    stick.current = atBottom;
    setAway((was) => (was === !atBottom ? was : !atBottom));
    if (offset < 240 && thread?.hasMore && !thread.loadingOlder) void loadOlder(staffId);
  };
  const jump = () => {
    stick.current = true;
    setAway(false);
    list.current?.scrollToIndex(count - 1, { align: 'end' });
  };

  return (
    <div className="transcript" ref={box}>
      {showEmpty ? (
        <div className="empty thread-empty">{empty}</div>
      ) : (
        <VList ref={list} className="transcript-list" shift={shift} onScroll={onScroll} bufferSize={600}>
          {[
            ...rows.map((r) => <RowView key={r.id} row={r} staff={staff} />),
            ...(running ? [<NowRow key="now" staff={staff} />] : []),
          ]}
        </VList>
      )}
      {away && (
        <button className="btn btn-line jump" onClick={jump}>
          Latest
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ composer

export interface ComposerFill {
  text: string;
  /** Changes each time the box should be filled again, even with the same text. */
  n: number;
}

/**
 * The box to write in. `hire` marks a message as sent from the hiring desk (the open draft's id,
 * or null when there is none yet); leave it undefined everywhere else.
 */
/** The server's limit for one attached file. */
const MAX_ATTACH = 25 * 1024 * 1024;

export function Composer({ staff, hire, fill, placeholder }: { staff: Staff; hire?: string | null; fill?: ComposerFill; placeholder?: string }) {
  const running = useStore((s) => !!s.live[staff.id]?.running);
  const phone = useIsPhone();
  const [text, setText] = useState(fill?.text ?? '');
  const [files, setFiles] = useState<{ id: string; name: string; bytes: number }[]>([]);
  const [sending, setSending] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);

  // Files chosen for one person do not follow to the next thread.
  useEffect(() => { setFiles([]); }, [staff.id]);

  const attach = async (chosen: FileList | null) => {
    if (!chosen) return;
    const list = [...chosen];
    if (pick.current) pick.current.value = '';
    for (const f of list) {
      if (f.size > MAX_ATTACH) { toast(`${f.name} is larger than 25 MB. Put it in Drop here in the office Drive folder instead.`); continue; }
      if (f.size === 0) { toast(`${f.name} is empty.`); continue; }
      setSending((n) => n + 1);
      try {
        const held = await api.upload(f);
        setFiles((cur) => (cur.length >= 10 ? cur : [...cur, held]));
      } catch (e) {
        toast((e as Error).message || `${f.name} could not be sent.`);
      } finally {
        setSending((n) => n - 1);
      }
    }
  };

  useEffect(() => {
    if (!phone) ref.current?.focus();
  }, [staff.id, phone]);
  useEffect(() => {
    if (!fill) return;
    setText(fill.text);
    const el = ref.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(fill.text.length, fill.text.length));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill?.n]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(168, el.scrollHeight)}px`;
  }, [text]);

  const ready = (!!text.trim() || files.length > 0) && sending === 0;
  const send = () => {
    if (!ready) return;
    void api.sendMessage(staff.id, text, { ...(hire === undefined ? {} : { hire }), files });
    setText('');
    setFiles([]);
  };
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };
  const label = placeholder ?? `Write to ${staff.name}`;
  return (
    <div className="composer">
      {(files.length > 0 || sending > 0) && (
        <ul className="composer-files" aria-label="Attached">
          {files.map((f) => (
            <li key={f.id}>
              <span className="composer-file-name">{f.name}</span>
              <span className="composer-file-size">{bytes(f.bytes)}</span>
              <button className="link" onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`}>
                Remove
              </button>
            </li>
          ))}
          {sending > 0 && <li className="composer-file-size">Sending {sending === 1 ? 'a file' : `${sending} files`} to the office</li>}
        </ul>
      )}
      <div className="composer-box">
        <input ref={pick} type="file" multiple hidden onChange={(e) => void attach(e.target.files)} />
        <button className="composer-attach" onClick={() => pick.current?.click()} aria-label="Attach a file" title="Attach a file">
          <PlusIcon color="currentColor" />
        </button>
        <textarea ref={ref} rows={1} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} placeholder={label} aria-label={label} enterKeyHint="send" />
        {running && (
          <button className="btn btn-line" onClick={() => void api.stop(staff.id)}>
            Stop
          </button>
        )}
        <button className="btn btn-blue" onClick={send} disabled={!ready}>
          Send
        </button>
      </div>
    </div>
  );
}
