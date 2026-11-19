import { useEffect, useRef, useState } from 'react';
import { ACTION_CLASSES, LEVEL_SHORT } from '@shared/contract.ts';
import type { Hire as HireDraft, Level, Staff } from '@shared/contract.ts';
import { BackIcon, Bubble, ColorPicker, Hatch, LevelMarks } from '../components/bits.tsx';
import { CatalogBrowser, SkillInside, SkillMeta } from '../components/Catalog.tsx';
import { Composer, Transcript, type ComposerFill } from '../components/Conversation.tsx';
import { pickLevelFor } from '../components/LevelPicker.tsx';
import { Signature } from '../components/Signature.tsx';
import { plural } from '../lib/format.ts';
import { confirmSignature, haptic } from '../lib/native.ts';
import { back, navigate, useSearch } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { toast, useChief, useHireDrafts, useIsPhone, useStore } from '../sync/store.ts';

type TextField = 'name' | 'letter' | 'role' | 'about' | 'profile';
const fields = (h: HireDraft): Record<TextField, string> => ({ name: h.name, letter: h.letter, role: h.role, about: h.about, profile: h.profile });

const STARTERS = [
  'I need someone to run the finance side: invoices out, receipts filed, months closed, tax dates watched.',
  'I want someone to keep my inbox and calendar under control.',
  'I am not sure what I need yet. Ask me about my week and tell me who is missing.',
];

/** The draft, as the owner edits it. The store holds the truth; this only holds what is being typed. */
function DraftEditor({ hire, chief, onSigned }: { hire: HireDraft; chief: Staff; onSigned: (name: string, staffId: string, again: boolean) => void }) {
  const target = useStore((s) => (hire.staffId ? s.staff[hire.staffId] : undefined));
  const [f, setF] = useState(() => fields(hire));
  /** Fields the owner has changed and not yet saved. Only these are protected from an incoming revision. */
  const dirty = useRef(new Set<TextField>());
  const [browsing, setBrowsing] = useState(false);
  const [inside, setInside] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);

  // A revision from the chief of staff, or a save of ours, lands here. What the owner is in the middle of typing is left alone.
  useEffect(() => {
    setF((prev) => {
      const next = fields(hire);
      for (const k of dirty.current) next[k] = prev[k];
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hire.rev]);

  const bind = (k: TextField) => ({
    value: f[k],
    onChange: (e: { target: { value: string } }) => {
      dirty.current.add(k);
      setF((prev) => ({ ...prev, [k]: e.target.value }));
    },
    onBlur: () => {
      if (!dirty.current.has(k)) return;
      if (f[k].trim() === hire[k]) {
        dirty.current.delete(k);
        return;
      }
      // Still ours until the save comes back, so a revision arriving meanwhile does not flash the old text.
      void api.saveHire(hire.id, { [k]: f[k] }).then((saved) => {
        if (!saved) return; // Not saved: keep what was typed, and try again on the next change.
        dirty.current.delete(k);
        setF((prev) => ({ ...prev, [k]: (useStore.getState().hires[hire.id] ?? hire)[k] }));
      });
    },
  });

  const setLevel = (classId: string, level: Level) => void api.saveHire(hire.id, { authority: { ...hire.authority, [classId]: level } });
  const setSkills = (next: { ref: string; take: boolean }[]) => api.saveHire(hire.id, { skills: next });
  const picks = hire.skills.map((s) => ({ ref: s.ref, take: s.take }));
  const taking = hire.skills.filter((s) => s.take).length;
  const skipped = hire.skills.length - taking;
  const name = f.name.trim() || 'this person';
  const again = !!hire.staffId;

  const sign = async () => {
    if (!(await confirmSignature(`Sign: ${again ? 'Set up' : 'Hire'} ${name} as ${f.role.trim()}`))) {
      haptic('warning');
      return;
    }
    setBusy(true);
    const res = await api.signHire(hire.id, { name: f.name, letter: f.letter, role: f.role, about: f.about, profile: f.profile });
    setBusy(false);
    if (!res) return;
    haptic('success');
    if (res.hire.problems?.length) toast(`${plural(res.hire.problems.length, 'skill')} could not be installed. See ${res.staff.name}’s thread.`);
    onSigned(res.staff.name, res.staff.id, again);
  };

  return (
    <div className="hire-draft">
      <header className="stack-sm">
        <div className="hire-kicker">
          {again ? `Setting ${target?.name ?? 'someone'} up again` : 'Proposed hire'}
          <span>Draft from {chief.name}</span>
        </div>
        {hire.note && (
          <p className="hire-note">
            <Bubble staff={chief} size={20} working={false} />
            <span>{hire.note}</span>
          </p>
        )}
        {again && <p className="skill-note">The folder, notes, duties and history stay as they are. Signing replaces the name, role, profile and authority below, and installs the chosen skills.</p>}
      </header>

      <section className="stack-sm">
        <p className="skill-note">Everything below is yours to change before you sign: the name, the role, the profile, each level and each skill.</p>
        <div className="hire-names">
          <label className="field grow">
            <span>Name</span>
            <input className="input" {...bind('name')} maxLength={60} />
          </label>
          <label className="field" style={{ width: 72 }}>
            <span>Letter</span>
            <input className="input" {...bind('letter')} maxLength={1} />
          </label>
        </div>
        <div className="field">
          <span>Bubble color</span>
          <ColorPicker value={hire.color ?? null} letter={(f.letter.trim() || f.name.trim()).slice(0, 1).toUpperCase()} onChange={(color) => void api.saveHire(hire.id, { color })} />
        </div>
        <label className="field">
          <span>Role</span>
          <input className="input" {...bind('role')} maxLength={60} />
        </label>
        <label className="field">
          <span>What this person is for</span>
          <textarea className="textarea" {...bind('about')} style={{ minHeight: 64 }} maxLength={600} />
          <small>Colleagues see this when deciding who to hand work to.</small>
        </label>
        <label className="field">
          <span>Profile</span>
          <textarea className="textarea hire-profile" {...bind('profile')} maxLength={8000} />
          <small>Written to the person. It is part of what they are told at the start of every piece of work.</small>
        </label>
      </section>

      <section className="aside-block">
        <div className="aside-head">
          <h2 className="aside-title">Authority to start with</h2>
          <span className="aside-meta">Raise it later as it is earned</span>
        </div>
        {ACTION_CLASSES.filter((c) => !c.chiefOnly || target?.isChief).map((c) => {
          if (c.locked) {
            return (
              <div key={c.id} className="auth-row">
                <span className="grow">{c.label}</span>
                <span className="auth-level never">Never</span>
                <Hatch width={49} />
              </div>
            );
          }
          const level = (hire.authority[c.id] ?? 0) as Level;
          return (
            <button key={c.id} className="auth-row" onClick={(e) => pickLevelFor(e.currentTarget, c.id, { name, current: level, onPick: (l) => setLevel(c.id, l) })} aria-label={`${c.label}: ${LEVEL_SHORT[level]}. Change`}>
              <span className="grow">{c.label}</span>
              <span className="auth-level">{LEVEL_SHORT[level]}</span>
              <LevelMarks level={level} />
            </button>
          );
        })}
      </section>

      <section className="aside-block">
        <div className="aside-head">
          <h2 className="aside-title">Skills</h2>
          <button className="link" style={{ fontSize: 13 }} onClick={() => setBrowsing(true)}>
            Add a skill
          </button>
        </div>
        {hire.skills.length === 0 ? (
          <p className="empty" style={{ fontSize: 14 }}>
            No skills proposed. A skill is a written procedure this person loads when a piece of work calls for it. They are installed in this person’s own folder and nobody else’s.
          </p>
        ) : (
          <p className="aside-meta" style={{ paddingBottom: 6 }}>
            {taking} to install{skipped ? `, ${skipped} considered and skipped` : ''}. Installed in this person’s own folder.
          </p>
        )}
        {hire.skills.map((s) => (
          <div key={s.ref} className={`skill-row${s.take ? '' : ' off'}`}>
            <input type="checkbox" className="skill-check" checked={s.take} aria-label={`Install ${s.name}`} onChange={(e) => void setSkills(picks.map((p) => (p.ref === s.ref ? { ...p, take: e.target.checked } : p)))} />
            <div className="grow">
              <div className="skill-name">{s.name}</div>
              {s.why && <div className="skill-why">{s.why}</div>}
              <SkillMeta source={s.source} plugin={s.plugin} scripts={s.scripts} />
            </div>
            <div className="skill-acts">
              <button className="btn btn-soft btn-sm" onClick={() => setInside(s.ref)}>
                Look inside
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="hire-sign">
        <div className="signoff-line" aria-hidden="true">
          <b>×</b>
          <i />
        </div>
        <p className="aside-meta">Nothing exists until you sign: no person, no folder, no skills.</p>
        <div className="row">
          <button className="btn btn-blue btn-lg" onClick={() => void sign()} disabled={busy || !f.name.trim() || !f.role.trim()}>
            {busy ? 'Signing' : again ? `Sign and set ${name} up` : `Sign and hire ${name}`}
          </button>
          {dropping ? (
            <>
              <button className="btn btn-ink" onClick={() => void api.dropHire(hire.id)}>
                Drop it
              </button>
              <button className="btn btn-quiet" onClick={() => setDropping(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn btn-quiet" onClick={() => setDropping(true)}>
              Drop draft
            </button>
          )}
        </div>
      </section>

      {browsing && (
        <CatalogBrowser
          title={`Add a skill for ${name}`}
          taken={new Set(hire.skills.map((s) => s.ref))}
          actionLabel="Add"
          doneLabel="In the draft"
          onPick={(s) => setSkills([...picks, { ref: s.id, take: true }])}
          onClose={() => setBrowsing(false)}
        />
      )}
      {inside && <SkillInside id={inside} onClose={() => setInside(null)} />}
    </div>
  );
}

function NoDraft({ chief, onStart, onTalk }: { chief: Staff; onStart: (text: string) => void; /** On a phone, back to the box to write in. */ onTalk?: () => void }) {
  return (
    <div className="hire-draft">
      <header className="stack-sm">
        <div className="hire-kicker">No draft yet</div>
        <h2 className="hire-lede">Tell {chief.name} what you need. The proposal appears here.</h2>
        <p className="panel-lede" style={{ margin: 0 }}>
          This is a conversation, not a form. {chief.name} asks about the job until it is clear, which can take a few rounds, then drafts a name, a role, a profile, starting authority and the skills worth installing. You can change anything in the draft or keep talking until it is
          right. Nothing exists until you sign.
        </p>
        {onTalk && (
          <button className="btn btn-blue" onClick={onTalk} style={{ alignSelf: 'flex-start' }}>
            Write to {chief.name}
          </button>
        )}
      </header>
      <section className="aside-block">
        <div className="aside-head">
          <h2 className="aside-title">Ways to begin</h2>
        </div>
        {STARTERS.map((s) => (
          <button key={s} className="starter" onClick={() => onStart(s)}>
            {s}
          </button>
        ))}
      </section>
    </div>
  );
}

function Signed({ name, again }: { name: string; again: boolean }) {
  return (
    <div className="hire-draft">
      <div className="hire-signed">
        <Signature animate large />
        <div className="signoff-line" aria-hidden="true">
          <b>×</b>
          <i />
        </div>
        <h2 className="hire-lede">{again ? `${name} is set up.` : `${name} is hired.`}</h2>
        <p className="panel-lede" style={{ margin: 0 }}>Opening their thread.</p>
      </div>
    </div>
  );
}

/** The hiring desk: the conversation with the chief of staff on one side, the draft on the other. */
export function Hire() {
  const chief = useChief();
  const drafts = useHireDrafts();
  const phone = useIsPhone();
  const search = new URLSearchParams(useSearch());
  const forId = search.get('for');
  // Arriving from the bar in the chief of staff's thread, or the Desk: open that draft.
  const askedFor = search.get('draft');
  const forStaff = useStore((s) => (forId ? s.staff[forId] : undefined));
  const [chosen, setChosen] = useState<string | null>(askedFor);
  const [side, setSide] = useState<'talk' | 'draft'>(askedFor ? 'draft' : 'talk');
  useEffect(() => {
    if (!askedFor) return;
    setChosen(askedFor);
    setSide('draft');
  }, [askedFor]);
  const [fill, setFill] = useState<ComposerFill | undefined>(undefined);
  const [signed, setSigned] = useState<{ name: string; again: boolean } | null>(null);
  const filledFor = useRef<string | null>(null);

  // Arriving from someone's settings page: start the sentence for the owner.
  useEffect(() => {
    if (!forStaff || filledFor.current === forStaff.id) return;
    filledFor.current = forStaff.id;
    setFill({ text: `Set ${forStaff.name} up again: `, n: Date.now() });
  }, [forStaff]);

  const draft = drafts.find((d) => d.id === chosen) ?? (forId ? drafts.find((d) => d.staffId === forId) : undefined) ?? drafts[0];
  // A draft arriving while the owner is in the conversation on a phone: say so on the switch, do not move them.
  const seen = useRef<string | null>(null);
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const key = draft ? `${draft.id}:${draft.rev}` : null;
    if (key && seen.current !== null && key !== seen.current && side === 'talk') setFresh(true);
    seen.current = key ?? '';
  }, [draft?.id, draft?.rev]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (side === 'draft') setFresh(false);
  }, [side]);

  if (!chief) return null;

  const start = (text: string) => {
    setFill({ text, n: Date.now() });
    setSide('talk');
  };
  const onSigned = (name: string, staffId: string, again: boolean) => {
    setSigned({ name, again });
    setSide('draft');
    window.setTimeout(() => navigate(`/t/${staffId}`), 1500);
  };

  const showTalk = !phone || side === 'talk';
  const showDraft = !phone || side === 'draft';

  return (
    <div className="thread hire">
      {showTalk && (
        <div className="thread-main">
          <header className="thread-head">
            <button className="phone-only btn" onClick={() => back('/')} aria-label="Back" style={{ padding: '0 6px 0 0', height: 40 }}>
              <BackIcon />
            </button>
            <Bubble staff={chief} size={40} />
            <div className="grow">
              <h1 className="thread-name">Hiring desk</h1>
              <p className="thread-sub">With {chief.name}. Talk it through; nothing exists until you sign.</p>
            </div>
            {phone && (
              <button className="btn btn-soft" onClick={() => setSide('draft')}>
                {fresh && <span className="dot" style={{ marginRight: 7 }} />}
                Draft
              </button>
            )}
          </header>
          <Transcript
            staff={chief}
            empty={
              <>
                <b>Start by saying what you need help with.</b> A sentence is enough. {chief.name} will ask what is missing.
              </>
            }
          />
          <Composer staff={chief} hire={draft?.id ?? null} fill={fill} placeholder={draft ? `Tell ${chief.name} what to change` : `Tell ${chief.name} who you need`} />
        </div>
      )}

      {showDraft && (
        <aside className="hire-side">
          {phone && (
            <div className="hire-side-bar">
              <button className="btn btn-soft" onClick={() => setSide('talk')}>
                <BackIcon />
                <span style={{ marginLeft: 8 }}>Conversation</span>
              </button>
            </div>
          )}
          {drafts.length > 1 && !signed && (
            <div className="hire-switch" role="tablist" aria-label="Open drafts">
              {drafts.map((d) => (
                <button key={d.id} role="tab" aria-selected={d.id === draft?.id} className={`btn btn-sm ${d.id === draft?.id ? 'btn-ink' : 'btn-soft'}`} onClick={() => setChosen(d.id)}>
                  {d.name || 'Unnamed'}
                </button>
              ))}
            </div>
          )}
          {signed ? <Signed name={signed.name} again={signed.again} /> : draft ? <DraftEditor key={draft.id} hire={draft} chief={chief} onSigned={onSigned} /> : <NoDraft chief={chief} onStart={start} onTalk={phone ? () => setSide('talk') : undefined} />}
        </aside>
      )}
    </div>
  );
}
