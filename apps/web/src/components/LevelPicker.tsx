import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { actionClass, LEVEL_LABEL } from '@shared/contract.ts';
import type { Level } from '@shared/contract.ts';
import { api } from '../sync/client.ts';
import { useStore } from '../sync/store.ts';
import { Check, LevelBar } from './bits.tsx';

/** A level that is not a member of staff's own yet: a line in a hiring draft. */
interface Custom {
  name: string;
  current: Level;
  onPick(level: Level): void;
}

interface PickerState {
  target: { staffId: string; classId: string; rect: DOMRect; custom?: Custom } | null;
}
const usePicker = create<PickerState>(() => ({ target: null }));

export function pickLevel(el: Element, staffId: string, classId: string): void {
  usePicker.setState({ target: { staffId, classId, rect: el.getBoundingClientRect() } });
}

/** The same popover for a level kept somewhere else, such as a hiring draft. */
export function pickLevelFor(el: Element, classId: string, custom: Custom): void {
  usePicker.setState({ target: { staffId: '', classId, rect: el.getBoundingClientRect(), custom } });
}

/** One popover for the whole app; cells call pickLevel() to open it next to themselves. */
export function LevelPicker() {
  const target = usePicker((s) => s.target);
  const staff = useStore((s) => (target ? s.staff[target.staffId] : undefined));
  const ref = useRef<HTMLDivElement>(null);
  const close = () => usePicker.setState({ target: null });

  useEffect(() => {
    if (!target) return;
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const t = window.setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', close);
    ref.current?.querySelector<HTMLButtonElement>('.pop-item.on')?.focus();
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', close);
    };
  }, [target]);

  const custom = target?.custom;
  if (!target || (!staff && !custom)) return null;
  const cls = actionClass(target.classId);
  if (!cls) return null;
  const who = custom?.name ?? staff!.name;
  const current = custom ? custom.current : ((staff!.authority[cls.id] ?? 0) as Level);
  const width = 260;
  const height = 262;
  const left = Math.max(12, Math.min(target.rect.left, window.innerWidth - width - 12));
  const below = target.rect.bottom + 6;
  const top = below + height > window.innerHeight ? Math.max(12, target.rect.top - height - 6) : below;

  return (
    <div ref={ref} className="pop" style={{ left, top, width }} role="menu" aria-label={`${who}: ${cls.label}`}>
      <div className="pop-title">
        <b>
          {who}: {cls.label.charAt(0).toLowerCase()}
          {cls.label.slice(1)}
        </b>
        {cls.hint}
      </div>
      {([4, 3, 2, 1, 0] as Level[]).map((level) => (
        <button
          key={level}
          role="menuitemradio"
          aria-checked={level === current}
          className={`pop-item${level === current ? ' on' : ''}`}
          onClick={() => {
            if (level !== current) {
              if (custom) custom.onPick(level);
              else void api.setAuthority(staff!.id, cls.id, level);
            }
            close();
          }}
        >
          <LevelBar level={level} />
          {LEVEL_LABEL[level]}
          {level === current && (
            <span className="tick">
              <Check />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
