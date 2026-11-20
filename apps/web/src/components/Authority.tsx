import { ACTION_CLASSES, LEVEL_SHORT } from '@shared/contract.ts';
import type { Level, Staff } from '@shared/contract.ts';
import { useStore } from '../sync/store.ts';
import { Hatch, LevelMarks } from './bits.tsx';
import { pickLevel } from './LevelPicker.tsx';

/**
 * What one person may do, a line per kind of action; tapping a line changes its level. `all`
 * lists every kind, with what each covers, for the edit page. Without it only the kinds the
 * person holds are listed, for their details beside the conversation.
 */
export function AuthorityList({ staff, all = false }: { staff: Staff; all?: boolean }) {
  const slips = useStore((s) => s.slips);
  const proposed = new Set<string>();
  for (const id in slips) {
    const s = slips[id]!;
    if (s.status === 'pending' && s.promotion?.staffId === staff.id) proposed.add(s.promotion.classId);
  }
  const classes = all ? ACTION_CLASSES : ACTION_CLASSES.filter((c) => c.locked || (staff.authority[c.id] ?? 0) > 0);
  return (
    <>
      {classes.map((c) => {
        const level = (staff.authority[c.id] ?? 0) as Level;
        const label = (
          <span className="grow">
            {c.label}
            {all && <small className="auth-hint">{c.locked ? c.lockedNote : c.chiefOnly && !staff.isChief ? `${c.hint} Only the chief of staff.` : c.hint}</small>}
          </span>
        );
        if (c.locked) {
          return (
            <div key={c.id} className="auth-row">
              {label}
              <span className="auth-level never">Never</span>
              <Hatch width={49} />
            </div>
          );
        }
        const fixed = c.chiefOnly && !staff.isChief;
        return (
          <button key={c.id} className="auth-row" disabled={fixed} onClick={(e) => pickLevel(e.currentTarget, staff.id, c.id)} aria-label={`${c.label}: ${LEVEL_SHORT[level]}. Change`}>
            {label}
            <span className="auth-level">{LEVEL_SHORT[level]}</span>
            <LevelMarks level={level} proposed={proposed.has(c.id) && level < 4} />
          </button>
        );
      })}
    </>
  );
}
