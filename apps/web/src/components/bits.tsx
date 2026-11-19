import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { STAFF_COLORS, staffColor } from '@shared/contract.ts';
import type { Level, Staff } from '@shared/contract.ts';
import { useStore } from '../sync/store.ts';

export function Bubble({ staff, letter, size = 30, working, needs, color }: { staff?: Staff | null; letter?: string; size?: 20 | 22 | 24 | 28 | 30 | 40; working?: boolean; /** Waiting on the owner: the ring turns red. */ needs?: boolean; /** Overrides the person's own color, for previews. */ color?: string | null }) {
  const live = useStore((s) => (staff ? s.live[staff.id]?.running : false));
  // At work but stopped on the owner's signature: still yellow, but it does not pulse.
  const held = useStore((s) => (staff ? !!s.live[staff.id]?.waitingSlipId : false));
  const on = working ?? !!live;
  const fill = staffColor(color === undefined ? staff?.color : color);
  return (
    <span className={`bubble s${size}${fill ? ' colored' : ''}${on ? ' working' : ''}${on && held ? ' held' : ''}${needs ? ' needs' : ''}`} style={fill ? ({ '--c': fill } as CSSProperties) : undefined} aria-hidden="true">
      {letter ?? staff?.letter ?? '?'}
    </span>
  );
}

/** Someone at work: a dot that pulses. Waiting on the owner: a red dot that keeps still. */
export const LiveMark = ({ waiting }: { waiting?: boolean }) => <span className={`livemark${waiting ? ' waiting' : ''}`} aria-hidden="true" />;

/** What to call a wait on the owner, from the slip being waited on. */
export function waitWords(kind: string | undefined): string {
  return kind === 'question' ? 'Waiting for your answer' : 'Waiting for your signature';
}

/** Choose a bubble color for a member of staff, or none. */
export function ColorPicker({ value, letter, onChange }: { value: string | null; letter: string; onChange: (color: string | null) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="Bubble color">
      {[{ id: null as string | null, label: 'Plain' }, ...STAFF_COLORS].map((c) => (
        <button key={c.id ?? 'plain'} type="button" role="radio" aria-checked={(value ?? null) === c.id} title={c.label} aria-label={c.label} className={`color-pick${(value ?? null) === c.id ? ' on' : ''}`} onClick={() => onChange(c.id)}>
          <Bubble letter={letter || '?'} size={28} working={false} color={c.id} />
        </button>
      ))}
    </div>
  );
}

export function Me({ size = 24 }: { size?: 24 | 30 }) {
  const initials = useStore((s) => s.settings?.ownerInitials || 'Me');
  return (
    <span className={`me${size === 30 ? ' s30' : ''}`} aria-hidden="true">
      {initials}
    </span>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <span className="wordmark-mark" aria-hidden="true">
        <i />
      </span>
      <span className="wordmark-name">Bureau</span>
    </span>
  );
}

/** Authority as a bar of four lengths. `unit` is the width of one step. */
export function LevelBar({ level, unit = 24, proposed, track }: { level: Level; unit?: number; proposed?: boolean; track?: boolean }) {
  return (
    <span className={`bar${track ? ' track' : ''}`} style={track ? { width: unit * 4 } : undefined} aria-hidden="true">
      {level > 0 && <b style={{ width: level * unit }} />}
      {proposed && <u style={{ width: unit }} />}
    </span>
  );
}

/** The same level as four marks, for narrow columns. */
export function LevelMarks({ level, proposed }: { level: Level; proposed?: boolean }) {
  return (
    <span className="marks" aria-hidden="true">
      {[1, 2, 3, 4].map((n) => (
        <i key={n} className={n <= level ? 'on' : proposed && n === level + 1 ? 'next' : undefined} />
      ))}
    </span>
  );
}

export function Hatch({ width = 96 }: { width?: number }) {
  return <span className="hatch" style={{ width }} aria-hidden="true" />;
}

export const Check = ({ color = 'currentColor', size = 12 }: { color?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6.3l2.6 2.6L10 3.2" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Chevron = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <circle cx="6" cy="6" r="4.5" stroke="var(--graphite)" strokeWidth="1.5" />
    <path d="M9.5 9.5L13 13" stroke="var(--graphite)" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const PlusIcon = ({ color = 'var(--graphite)' }: { color?: string }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1v10M1 6h10" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const MicIcon = ({ color = 'var(--on-blue)' }: { color?: string }) => (
  <svg width="16" height="20" viewBox="0 0 16 18" aria-hidden="true">
    <rect x="5" y="1" width="6" height="10" rx="3" fill={color} />
    <path d="M2.5 8.5a5.5 5.5 0 0011 0M8 14v3" stroke={color} strokeWidth="1.6" fill="none" strokeLinecap="round" />
  </svg>
);

export const CameraIcon = () => (
  <svg width="20" height="17" viewBox="0 0 20 17" fill="none" aria-hidden="true">
    <path d="M2.5 4.25h3l1.4-2.25h6.2l1.4 2.25h3a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5h-15a1.5 1.5 0 01-1.5-1.5v-8a1.5 1.5 0 011.5-1.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx="10" cy="9.6" r="3.1" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);

export const SendIcon = ({ color = 'var(--on-blue)' }: { color?: string }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 13.5V3M3.5 7.2L8 2.7l4.5 4.5" stroke={color} strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const BackIcon = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
    <path d="M8 2L2 8l6 6" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Bottom sheet used on the phone for details and choices. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>{title}</span>
          <button className="btn btn-soft" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Loads something once and says so while it loads or when it fails. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load this.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1) };
}
