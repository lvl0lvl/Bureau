import { Fragment } from 'react';
import { ACTION_CLASSES, LEVEL_LABEL, recordTotal } from '@shared/contract.ts';
import type { Level } from '@shared/contract.ts';
import { Bubble, Hatch, LevelBar } from '../components/bits.tsx';
import { pickLevel } from '../components/LevelPicker.tsx';
import { Link } from '../lib/router.tsx';
import { useChief, useSlipList, useStaffByAttention, useStaffList, useStore } from '../sync/store.ts';

export function StaffMatrix() {
  const staff = useStaffList();
  // The phone's list of people leads with whoever needs the owner. The table keeps its fixed columns.
  const { staff: byAttention, waiting } = useStaffByAttention();
  const slips = useSlipList();
  const live = useStore((s) => s.live);
  const chief = useChief();

  const promotions = slips.filter((s) => s.status === 'pending' && s.promotion);
  const proposed = new Set(promotions.map((s) => `${s.promotion!.staffId}:${s.promotion!.classId}`));
  const groups = [...new Set(ACTION_CLASSES.map((c) => c.group))];
  const columns = `minmax(200px, 264px) repeat(${Math.max(1, staff.length)}, minmax(118px, 1fr))`;
  const lastClass = ACTION_CLASSES[ACTION_CLASSES.length - 1]!.id;

  return (
    <div className="page">
      <section className="phone-only" aria-label="People">
        <div className="aside-block">
          <div className="aside-head">
            <h2 className="section-title">Staff</h2>
            <Link to="/hire" className="link" style={{ fontSize: 13 }}>
              Hire someone
            </Link>
          </div>
          {byAttention.map((s) => (
            <Link key={s.id} to={`/t/${s.id}`} className="person-row">
              <Bubble staff={s} needs={waiting.has(s.id)} />
              <span className="grow">
                <span className="roster-name" style={{ display: 'block' }}>{s.name}</span>
                <span className="roster-role" style={{ display: 'block' }}>
                  {waiting.has(s.id) ? 'Waiting on you' : live[s.id]?.running ? (live[s.id]!.activity ?? 'Working') : s.role}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <header className="page-head">
        <div>
          <h1 className="page-title">Who may do what</h1>
          <p className="page-lede">
            Everyone starts by drafting. You promote someone when their record supports it, and you can take it back at any time. Nobody moves money.{' '}
            <Link to="/hire" className="link desk-only">
              Hire someone
            </Link>
          </p>
        </div>
        <div className="legend" aria-hidden="true">
          {([1, 2, 3, 4] as Level[]).map((l) => (
            <div key={l}>
              <LevelBar level={l} />
              {LEVEL_LABEL[l]}
            </div>
          ))}
        </div>
      </header>

      <div className="matrix-wrap">
        <div className="matrix" style={{ gridTemplateColumns: columns }} role="table" aria-label="Authority by person">
          <div className="mx-head" role="row">
            <div className="mx-corner">Signed as written, last 30 days</div>
            {staff.map((s) => {
              const total = recordTotal(s.record);
              return (
                <div key={s.id} role="columnheader">
                  <Link to={`/t/${s.id}`} className="mx-person">
                    <Bubble staff={s} size={28} />
                    {s.name}
                  </Link>
                  <span className="mx-record">{total ? `${s.record.asWritten} of ${total}` : 'No slips yet'}</span>
                </div>
              );
            })}
          </div>

          {groups.map((g) => (
            <Fragment key={g}>
              <div className="mx-group">{g}</div>
              {ACTION_CLASSES.filter((c) => c.group === g).map((c) => (
                <div key={c.id} className={`mx-row${c.id === lastClass ? ' last' : ''}`} role="row">
                  <div className="mx-label" role="rowheader" title={c.hint}>
                    {c.label}
                  </div>
                  {c.locked ? (
                    <div className="mx-locked">
                      <Hatch />
                      <span>{c.lockedNote}</span>
                    </div>
                  ) : (
                    staff.map((s) => {
                      const level = (s.authority[c.id] ?? 0) as Level;
                      if (c.chiefOnly && !s.isChief) return <div key={s.id} className="mx-cell" />;
                      return (
                        <button key={s.id} className="mx-cell" onClick={(e) => pickLevel(e.currentTarget, s.id, c.id)} aria-label={`${s.name}, ${c.label}: ${LEVEL_LABEL[level]}. Change`}>
                          <LevelBar level={level} proposed={proposed.has(`${s.id}:${c.id}`) && level < 4} />
                        </button>
                      );
                    })
                  )}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>

      <p className="page-lede" style={{ paddingTop: 0, fontSize: 13, lineHeight: '19px' }}>
        Only {chief?.name ?? 'the chief of staff'} checks slips. Whoever reads outside mail or web pages never signs off on what they ask for: after reading them, anything that would have gone ahead on its own comes to you as a slip instead. Select a bar to change a level.
      </p>

      {promotions.map((p) => {
        const who = staff.find((s) => s.id === p.promotion!.staffId);
        const cls = ACTION_CLASSES.find((c) => c.id === p.promotion!.classId);
        return (
          <div key={p.id} className="callout">
            <span className="bar">
              <u />
            </span>
            <p>
              <b>A promotion is waiting for your signature.</b> {who?.name ?? 'Someone'} would {cls ? `${cls.label.charAt(0).toLowerCase()}${cls.label.slice(1)}` : 'act'} without asking{p.promotion!.limit ? `, up to ${p.promotion!.limit} each` : ''}. Record: {p.promotion!.record}.
            </p>
            <Link to="/" className="btn btn-blue">
              Review and sign
            </Link>
          </div>
        );
      })}

      <p className="phone-only muted" style={{ fontSize: 14 }}>
        <Link to="/library" className="link" style={{ color: 'var(--ink)' }}>
          Library
        </Link>
        {'  '}
        <Link to="/settings" className="link" style={{ color: 'var(--ink)', marginLeft: 16 }}>
          Settings
        </Link>
      </p>
    </div>
  );
}
