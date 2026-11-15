import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { COMPACT_AT_MAX, COMPACT_AT_MIN, compactAt, usageGuard } from '@shared/contract.ts';
import type { BackupStatus, CatalogPage, Connector, Device, DriveStatus, Duty, Effort, EngineInfo, InstalledSkill, ModelOption, Staff, UsageGuard } from '@shared/contract.ts';
import { Bubble, ColorPicker, useLoad } from '../components/bits.tsx';
import { CatalogBrowser, SkillInside, SkillMeta } from '../components/Catalog.tsx';
import { Signature } from '../components/Signature.tsx';
import { Bar, contextReading, weekReading } from '../components/Usage.tsx';
import { bytes, clock, longDate, plural, tokens, when } from '../lib/format.ts';
import { Link, navigate, useHash } from '../lib/router.tsx';
import { inNativeApp, nativePlatform } from '../lib/native.ts';
import { api, type PushInfo } from '../sync/client.ts';
import { toast, useChief, useNow, useStaffList, useStore } from '../sync/store.ts';
import { reloadPlanUsage, usePlanUsage } from '../sync/usage.ts';

const W = 600;
const H = 160;
type Pt = { x: number; y: number };
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Smooths a stroke by running curves through the midpoints between samples. */
function strokePath(pts: Pt[]): string {
  if (!pts.length) return '';
  const p0 = pts[0]!;
  if (pts.length === 1) return `M${r1(p0.x)} ${r1(p0.y)}l0.1 0`;
  let d = `M${r1(p0.x)} ${r1(p0.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    d += `Q${r1(a.x)} ${r1(a.y)} ${r1((a.x + b.x) / 2)} ${r1((a.y + b.y) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d}L${r1(last.x)} ${r1(last.y)}`;
}

function SignaturePad() {
  const saved = useStore((s) => s.settings?.signature ?? null);
  const [paths, setPaths] = useState<string[]>(saved?.paths ?? []);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [play, setPlay] = useState(0);
  const stroke = useRef<Pt[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dirty) setPaths(saved?.paths ?? []);
  }, [saved, dirty]);

  const point = (e: PointerEvent): Pt => {
    const r = box.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    stroke.current = [point(e)];
    setDraft(strokePath(stroke.current));
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const s = stroke.current;
    if (!s) return;
    const p = point(e);
    const last = s[s.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) < 1.6) return;
    s.push(p);
    setDraft(strokePath(s));
  };
  const up = () => {
    const s = stroke.current;
    if (!s) return;
    stroke.current = null;
    setPaths((prev) => [...prev, strokePath(s)]);
    setDraft('');
    setDirty(true);
  };
  const save = async () => {
    await api.saveSettings({ signature: { paths, width: W, height: H } });
    setDirty(false);
    setPlay((n) => n + 1);
    toast('Signature saved.');
  };
  const clear = () => {
    setPaths([]);
    setDirty(true);
  };
  const useScript = async () => {
    await api.saveSettings({ signature: null });
    setPaths([]);
    setDirty(false);
    setPlay((n) => n + 1);
  };

  return (
    <div className="stack-sm">
      <div ref={box} className="sigpad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} role="img" aria-label="Draw your signature here">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          {paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
          {draft && <path d={draft} />}
        </svg>
        {paths.length === 0 && !draft && <div className="sigpad-hint">Sign here with your mouse, trackpad or finger</div>}
      </div>
      <div className="row">
        <button className="btn btn-blue" onClick={() => void save()} disabled={!dirty || paths.length === 0}>
          Save signature
        </button>
        <button className="btn btn-line" onClick={clear} disabled={paths.length === 0}>
          Clear
        </button>
        {saved && (
          <button className="btn btn-quiet" onClick={() => void useScript()}>
            Use the script face instead
          </button>
        )}
      </div>
      <div className="row" style={{ alignItems: 'center', gap: 18 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          How it looks when you sign
        </span>
        <span style={{ height: 74, display: 'flex', alignItems: 'center' }}>
          <Signature key={play} animate={play > 0} large />
        </span>
        <button className="btn btn-soft btn-sm" onClick={() => setPlay((n) => n + 1)}>
          Play
        </button>
      </div>
    </div>
  );
}

function DutyEditor({ duty, staffId, onDone }: { duty?: Duty; staffId: string; onDone: () => void }) {
  const [f, setF] = useState({ title: duty?.title ?? '', cadence: duty?.cadence ?? '', cron: duty?.cron ?? '', prompt: duty?.prompt ?? '', enabled: duty?.enabled ?? true });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const data = { title: f.title.trim(), cadence: f.cadence.trim() || 'As needed', cron: f.cron.trim() || null, prompt: f.prompt.trim(), enabled: f.enabled };
    if (duty) await api.saveDuty(duty.id, data);
    else await api.addDuty({ ...data, staffId });
    onDone();
  };
  return (
    <form className="stack-sm" onSubmit={save} style={{ padding: '12px 0 16px', borderTop: '1px solid var(--rule)' }}>
      <div className="grid2">
        <label className="field">
          <span>Duty</span>
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Reconcile the accounts" autoFocus />
        </label>
        <label className="field">
          <span>How often, in plain words</span>
          <input className="input" value={f.cadence} onChange={(e) => setF({ ...f, cadence: e.target.value })} placeholder="Every Friday" />
        </label>
      </div>
      <label className="field">
        <span>What to do each time</span>
        <textarea className="textarea" value={f.prompt} onChange={(e) => setF({ ...f, prompt: e.target.value })} placeholder="Match the bank export against receipts, close the week and tell me what does not fit." />
      </label>
      <label className="field">
        <span>Schedule</span>
        <input className="input" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} placeholder="0 6 * * 5" style={{ fontFamily: 'var(--narrow)' }} />
        <small>Five fields: minute, hour, day of month, month, day of week. Leave empty for a duty done as work arrives.</small>
      </label>
      <label className="check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Active
      </label>
      <div className="row">
        <button className="btn btn-blue" type="submit" disabled={!f.title.trim()}>
          {duty ? 'Save duty' : 'Add duty'}
        </button>
        <button className="btn btn-quiet" type="button" onClick={onDone}>
          Cancel
        </button>
        {duty && (
          <button
            className="btn btn-quiet"
            type="button"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              void api.removeDuty(duty.id);
              onDone();
            }}
          >
            Remove duty
          </button>
        )}
      </div>
    </form>
  );
}

/** The models the office's Claude account can use. Asked once per visit; it starts Claude Code but spends no usage. */
let modelsAsked: Promise<ModelOption[]> | null = null;
function useModels(): ModelOption[] | null {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    let live = true;
    modelsAsked ??= api.engineInfo().then((d) => d.models ?? []).catch(() => { modelsAsked = null; return []; });
    void modelsAsked.then((m) => { if (live) setModels(m); });
    return () => { live = false; };
  }, []);
  return models;
}

const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };

function PersonEditor({ staff }: { staff: Staff }) {
  const t = useNow(60_000);
  const dutyMap = useStore((s) => s.duties);
  const duties = useMemo(() => Object.values(dutyMap).filter((d) => d.staffId === staff.id), [dutyMap, staff.id]);
  const [f, setF] = useState({ name: staff.name, letter: staff.letter, color: staff.color ?? null, role: staff.role, about: staff.about, instructions: staff.instructions, model: staff.model ?? '', effort: (staff.effort ?? '') as Effort | '', configDir: staff.configDir ?? '' });
  const models = useModels();
  const usual = models?.find((m) => m.value === 'default') ?? null;
  const choices = (models ?? []).filter((m) => m.value !== 'default');
  const chosen = f.model ? choices.find((m) => m.value === f.model) : usual;
  // Until the list has arrived, or for a model it does not name, offer every level.
  const efforts: Effort[] = chosen ? chosen.efforts : ['low', 'medium', 'high', 'xhigh', 'max'];
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const chief = useChief();
  const dirty = f.name !== staff.name || f.letter !== staff.letter || f.color !== (staff.color ?? null) || f.role !== staff.role || f.about !== staff.about || f.instructions !== staff.instructions || f.model !== (staff.model ?? '') || f.effort !== (staff.effort ?? '') || f.configDir !== (staff.configDir ?? '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    await api.saveStaff(staff.id, { name: f.name.trim(), letter: (f.letter.trim() || f.name.trim()).slice(0, 1).toUpperCase(), color: f.color, role: f.role.trim(), about: f.about.trim(), instructions: f.instructions.trim(), model: f.model.trim() || null, effort: f.effort && efforts.includes(f.effort) ? f.effort : null, configDir: f.configDir.trim() || null });
    toast(`Saved ${f.name.trim()}.`);
  };

  return (
    <div className="stack" style={{ padding: '6px 0 22px 42px' }}>
      <form className="stack-sm" onSubmit={save}>
        <div className="grid2">
          <label className="field">
            <span>Name</span>
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Letter in the bubble</span>
            <input className="input" value={f.letter} maxLength={1} onChange={(e) => setF({ ...f, letter: e.target.value })} style={{ width: 72 }} />
          </label>
        </div>
        <div className="field">
          <span>Bubble color</span>
          <ColorPicker value={f.color} letter={(f.letter.trim() || f.name.trim()).slice(0, 1).toUpperCase()} onChange={(color) => setF({ ...f, color })} />
          <small>Only to tell people apart. A yellow ring still means working now.</small>
        </div>
        <label className="field">
          <span>Role</span>
          <input className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} />
        </label>
        <label className="field">
          <span>What this person is for</span>
          <textarea className="textarea" value={f.about} onChange={(e) => setF({ ...f, about: e.target.value })} style={{ minHeight: 64 }} />
        </label>
        <label className="field">
          <span>Profile</span>
          <textarea className="textarea" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} placeholder="What this person is here for, how you like the work done, what they never do. Written to them, followed every time." style={{ minHeight: f.instructions.length > 400 ? 220 : 110 }} />
          <small>Part of what {staff.name} is told at the start of every piece of work.</small>
        </label>
        <div className="grid2">
          <label className="field">
            <span>Claude model</span>
            <select className="input select" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })}>
              <option value="">Your account’s usual model{usual ? ` (${usual.description.split(' · ')[0]})` : ''}</option>
              {choices.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.name}
                </option>
              ))}
              {f.model && models && !choices.some((m) => m.value === f.model) && <option value={f.model}>{f.model} (not a model your account lists)</option>}
            </select>
            <small>{models === null ? 'Asking Claude Code which models your account has.' : chosen?.description || 'Which Claude model does this person’s work.'}</small>
          </label>
          <label className="field">
            <span>Effort</span>
            <select className="input select" value={efforts.includes(f.effort as Effort) ? f.effort : ''} disabled={!efforts.length} onChange={(e) => setF({ ...f, effort: e.target.value as Effort | '' })}>
              <option value="">The model’s usual effort</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {EFFORT_LABEL[e]}
                </option>
              ))}
            </select>
            <small>{efforts.length ? 'Higher effort thinks longer: better on hard work, slower, and uses more of your plan.' : 'Effort cannot be set for this model.'}</small>
          </label>
        </div>
        <label className="field">
          <span>Claude account folder</span>
          <input className="input" value={f.configDir} onChange={(e) => setF({ ...f, configDir: e.target.value })} placeholder="This Mac’s signed-in account" />
          <small>Only for a second account you signed in to yourself on this Mac, in its own folder.</small>
        </label>
        <div className="row">
          <button className="btn btn-blue" type="submit" disabled={!dirty || !f.name.trim()}>
            Save changes
          </button>
          <Link to={`/t/${staff.id}`} className="btn btn-soft">
            Open thread
          </Link>
          {chief && (
            <Link to={`/hire?for=${encodeURIComponent(staff.id)}`} className="btn btn-soft" title={`Talk it through with ${chief.name}: a new profile, starting authority and skills, as a draft you sign.`}>
              Set up again with {chief.name}
            </Link>
          )}
          {!staff.isChief &&
            (confirmRetire ? (
              <>
                <button className="btn btn-ink" type="button" style={{ marginLeft: 'auto' }} onClick={() => void api.retire(staff.id)}>
                  Retire {staff.name} now
                </button>
                <button className="btn btn-quiet" type="button" onClick={() => setConfirmRetire(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button className="btn btn-quiet" type="button" style={{ marginLeft: 'auto' }} onClick={() => setConfirmRetire(true)}>
                Retire
              </button>
            ))}
        </div>
      </form>

      <SkillsSection staff={staff} />

      <div>
        <div className="aside-head">
          <h3 className="aside-title">Duties</h3>
          <button className="link" style={{ fontSize: 13 }} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
            Add a duty
          </button>
        </div>
        {editing === 'new' && <DutyEditor staffId={staff.id} onDone={() => setEditing(null)} />}
        {duties.length === 0 && editing !== 'new' && <p className="empty" style={{ fontSize: 14 }}>No duties yet. A duty is something {staff.name} keeps doing without being asked.</p>}
        {duties.map((d) =>
          editing === d.id ? (
            <DutyEditor key={d.id} duty={d} staffId={staff.id} onDone={() => setEditing(null)} />
          ) : (
            <div key={d.id} className="duty" style={{ alignItems: 'center' }}>
              <div className="grow">
                <div className="duty-title">{d.title}</div>
                <div className="duty-cadence">
                  {d.cadence}
                  {!d.enabled && ', paused'}
                  {d.lastDoneAt ? `. Last done ${when(d.lastDoneAt, t)}` : ''}
                </div>
                {d.held && d.enabled && <div className="duty-held">Held {when(d.held.at, t)}: {d.held.why}.</div>}
              </div>
              <button className="btn btn-soft btn-sm" onClick={() => void api.runDuty(d.id).then(() => toast(`${staff.name} is on it.`))}>
                Run now
              </button>
              <button className="btn btn-soft btn-sm" onClick={() => setEditing(d.id)}>
                Edit
              </button>
            </div>
          ),
        )}
      </div>

      <Briefing staff={staff} />
    </div>
  );
}

/** The skills in one person's own folder. */
function SkillsSection({ staff }: { staff: Staff }) {
  const skills = staff.skills ?? [];
  const [browsing, setBrowsing] = useState(false);
  const [inside, setInside] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const again = async (s: InstalledSkill) => {
    if (!s.ref) return;
    setBusy(s.id);
    const res = await api.installSkill(staff.id, s.ref);
    setBusy(null);
    if (res) toast(`${s.name} is installed again for ${staff.name}.`);
  };
  const remove = async (s: InstalledSkill) => {
    setBusy(s.id);
    await api.removeSkill(staff.id, s.id);
    setBusy(null);
  };

  return (
    <div>
      <div className="aside-head">
        <h3 className="aside-title">Skills</h3>
        <button className="link" style={{ fontSize: 13 }} onClick={() => setBrowsing(true)}>
          Add a skill
        </button>
      </div>
      {skills.length === 0 && (
        <p className="empty" style={{ fontSize: 14 }}>
          No skills yet. A skill is a written procedure {staff.name} loads when a piece of work calls for it. It is installed in {staff.name}’s own folder and nobody else’s.
        </p>
      )}
      {skills.map((s) => (
        <div key={s.id} className={`skill-row${s.held ? ' held' : ''}`}>
          <div className="grow">
            <div className="skill-name">{s.name}</div>
            {s.held ? (
              <div className="skill-why red">Not in use. Its files stopped matching what was installed, so it was moved out of {staff.name}’s folder. Install it again to put back the catalog’s copy.</div>
            ) : (
              <div className="skill-desc clamp">{s.description}</div>
            )}
            <SkillMeta source={s.source} plugin={s.plugin} scripts={s.scripts} />
          </div>
          <div className="skill-acts">
            {s.ref && !s.held && (
              <button className="btn btn-soft btn-sm" onClick={() => setInside(s.ref)}>
                Look inside
              </button>
            )}
            {s.held && s.ref && (
              <button className="btn btn-line btn-sm" disabled={busy === s.id} onClick={() => void again(s)}>
                Install again
              </button>
            )}
            <button className="btn btn-soft btn-sm" disabled={busy === s.id} onClick={() => void remove(s)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      {browsing && (
        <CatalogBrowser
          title={`Add a skill for ${staff.name}`}
          taken={new Set(skills.filter((s) => !s.held && s.ref).map((s) => s.ref!))}
          actionLabel="Install"
          doneLabel="Installed"
          onPick={(s) => api.installSkill(staff.id, s.id)}
          onClose={() => setBrowsing(false)}
        />
      )}
      {inside && <SkillInside id={inside} onClose={() => setInside(null)} />}
    </div>
  );
}

/** Exactly what this person is told at the start of every piece of work. */
function Briefing({ staff }: { staff: Staff }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ text: string; folder: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setProblem(null);
    api
      .briefing(staff.id)
      .then((d) => live && setData(d))
      .catch((e) => live && setProblem(e instanceof Error ? e.message : 'Could not load the briefing.'));
    return () => {
      live = false;
    };
    // Reloads when the profile, authority or skills change while it is open.
  }, [open, staff.id, staff.rev]);
  return (
    <div>
      <div className="aside-head">
        <h3 className="aside-title">What {staff.name} is told</h3>
        <button className="link" style={{ fontSize: 13 }} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
      </div>
      {!open && <p className="empty" style={{ fontSize: 14 }}>The office, the colleagues, the authority levels and the profile, as {staff.name} reads them before each piece of work.</p>}
      {open && problem && <p className="empty">{problem}</p>}
      {open && !data && !problem && <p className="empty">Loading.</p>}
      {open && data && (
        <div className="stack-sm">
          <p className="skill-note">
            Folder on this Mac: <span style={{ color: 'var(--ink)', overflowWrap: 'anywhere' }}>{data.folder}</span>. A copy of this is written there as BRIEFING.md before each piece of work. Change it by editing the profile, the authority or the skills; {staff.name} cannot change it.
          </p>
          <pre className="briefing">{data.text}</pre>
        </div>
      )}
    </div>
  );
}

/** Where skills come from. Nothing is fetched until a button here is pressed. */
function CatalogSources() {
  const t = useNow(60_000);
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const load = () =>
    api
      .catalog('', { limit: 1 })
      .then((p) => (setPage(p), setProblem(null)))
      .catch((e) => setProblem(e instanceof Error ? e.message : 'Could not open the catalog.'));
  useEffect(() => {
    void load();
  }, []);

  const fetchOne = async (id?: string) => {
    setBusy(id ?? 'all');
    await api.catalogRefresh(id);
    await load();
    setBusy(null);
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const res = await api.catalogAddSource(repo);
    if (!res) return;
    setRepo('');
    await load();
  };
  const remove = async (id: string) => {
    await api.catalogRemoveSource(id);
    await load();
  };

  if (problem) return <p className="empty">{problem}</p>;
  if (!page) return <p className="empty">Opening the catalog.</p>;
  const remote = page.sources.filter((s) => s.id !== 'house');
  return (
    <div className="stack-sm">
      <div>
        {page.sources.map((s) => {
          const house = s.id === 'house';
          const working = busy === s.id || (busy === 'all' && !house);
          return (
            <div key={s.id} className="lane-row" style={{ alignItems: 'center' }}>
              <span className="lane-text">
                <b style={{ fontWeight: 600 }}>{s.label}</b>
                <span className="lane-note" style={{ display: 'block' }}>
                  {house ? 'Written for this office and shipped with Bureau' : `github.com/${s.repo}`}
                  {'. '}
                  {working ? 'Fetching from GitHub. This can take a minute.' : house ? plural(s.skills, 'skill') : s.fetchedAt ? `${plural(s.skills, 'skill')}, fetched ${when(s.fetchedAt, t)}` : 'Not fetched yet'}
                </span>
                {s.error && !working && (
                  <span className="lane-note red" style={{ display: 'block' }}>
                    {s.error}
                  </span>
                )}
              </span>
              {!house && (
                <>
                  <button className="btn btn-soft btn-sm" disabled={busy !== null} onClick={() => void fetchOne(s.id)}>
                    {working ? 'Fetching' : s.fetchedAt ? 'Fetch again' : 'Fetch'}
                  </button>
                  <button className="btn btn-quiet btn-sm" disabled={busy !== null} onClick={() => void remove(s.id)}>
                    Remove
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {remote.length > 1 && (
        <div className="row">
          <button className="btn btn-line" disabled={busy !== null} onClick={() => void fetchOne()}>
            {busy === 'all' ? 'Fetching all' : 'Fetch all'}
          </button>
        </div>
      )}
      <form className="row" onSubmit={add} style={{ alignItems: 'flex-end' }}>
        <label className="field grow" style={{ minWidth: 220 }}>
          <span>Add a source</span>
          <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name on GitHub" />
        </label>
        <button className="btn btn-line" type="submit" disabled={!repo.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}

/**
 * The recovery key, shown once. It lives in this component's state and nowhere else: closing the
 * dialog is the last anyone sees of it, so it cannot be closed until the owner says it is saved.
 */
function RecoveryKeyDialog({ recoveryKey, replaced, onDone }: { recoveryKey: string; replaced: boolean; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      toast('Could not copy. Select the key and copy it by hand.');
    }
  };
  return (
    <div className="dialog-scrim">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Your recovery key" style={{ maxWidth: 560 }}>
        <div className="dialog-head">
          <h2>Your recovery key</h2>
        </div>
        <div className="dialog-body stack-sm">
          <p style={{ fontSize: 15, lineHeight: '22px' }}>
            Save this in 1Password now. Bureau does not keep it and cannot show it again. Without it, no backup can be opened, by you or by anyone else.
          </p>
          <div className="recovery-key" aria-label="Recovery key">
            {recoveryKey}
          </div>
          <div className="row">
            <button className="btn btn-line" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {copied && <span className="lane-note">It is on the clipboard. Paste it into 1Password, then copy something else.</span>}
          </div>
          {replaced && <p className="lane-note">Backups made before today still need the old key. Keep both, and label them with their dates.</p>}
          <label className="check" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            I have saved it
          </label>
        </div>
        <div className="dialog-foot">
          <button className="btn btn-ink" disabled={!saved} onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** The office's folder in Google Drive, and the nightly backups that go into it. */
function DriveAndBackup() {
  const t = useNow(60_000);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'folder' | 'key' | 'backup' | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  // The recovery key is held here only while its dialog is open.
  const [shown, setShown] = useState<{ recoveryKey: string; replaced: boolean } | null>(null);
  const pathInput = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [d, b] = await Promise.all([api.driveStatus(), api.backupStatus()]);
      setDrive(d);
      setBackup(b);
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not load this.');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const choose = async (folder: string | null) => {
    setBusy('folder');
    const res = await api.chooseDrive(folder);
    setBusy(null);
    if (!res) return;
    setDrive(res.drive);
    setBackup(res.backup);
    setEditing(false);
    setPath('');
  };
  const backUp = async () => {
    setBusy('backup');
    const res = await api.runBackup();
    if (res?.status) setBackup(res.status);
    await load();
    setBusy(null);
  };
  const makeKey = async (replace: boolean) => {
    setBusy('key');
    const res = await api.createBackupKey(replace);
    setBusy(null);
    setConfirmReplace(false);
    if (!res) return;
    setBackup(res.status);
    setShown({ recoveryKey: res.recoveryKey, replaced: replace });
  };
  const keySaved = () => {
    setShown(null);
    // A backup locked to this key is made as soon as the key is safe, when nothing else stands in its way.
    if (backup && !backup.problem) void backUp();
  };

  if (problem && !drive) {
    return (
      <section className="panel" id="drive">
        <h2 className="panel-title">Drive folder</h2>
        <p className="empty">{problem}</p>
      </section>
    );
  }
  if (!drive || !backup) {
    return (
      <section className="panel" id="drive">
        <h2 className="panel-title">Drive folder</h2>
        <p className="empty">Looking for the folder.</p>
      </section>
    );
  }

  const showForm = !drive.folder || editing;
  const startTyping = (mount: string) => {
    setPath(`${mount}/`);
    requestAnimationFrame(() => {
      const el = pathInput.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.scrollLeft = el.scrollWidth;
    });
  };

  return (
    <>
      <section className="panel" id="drive">
        <h2 className="panel-title">Drive folder</h2>
        <p className="panel-lede">
          One folder in your Google Drive that belongs to the office. You drop documents into it from any device, staff file them and leave finished work there, and backups go into it. Bureau reaches it as ordinary files that Google Drive for desktop keeps in step, so it never holds a Google password.
        </p>
        <div className="stack-sm">
          {drive.folder ? (
            <div className="lane-row" style={{ alignItems: 'center' }}>
              <span className="lane-text">
                <b style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{drive.folder}</b>
                {drive.found ? (
                  <span className="lane-note" style={{ display: 'block' }}>Bureau can see this folder.</span>
                ) : (
                  <span className="lane-note red" style={{ display: 'block' }}>
                    Bureau cannot see this folder. Google Drive may not be running on this Mac, or the folder may have been moved or renamed. Nothing was created.
                  </span>
                )}
              </span>
              {!editing && (
                <>
                  <button className="btn btn-soft btn-sm" disabled={busy !== null} onClick={() => (setEditing(true), setPath(drive.folder ?? ''))}>
                    Change
                  </button>
                  <button className="btn btn-quiet btn-sm" disabled={busy !== null} onClick={() => void choose(null)}>
                    Stop using it
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="empty">No folder is chosen yet, so staff have no shared place in Drive and backups cannot run.</p>
          )}

          {drive.folder && drive.found && !editing && (
            <div>
              {drive.folders.map((f) => (
                <div key={f.name} className="lane-row">
                  <span className="lane-text">
                    <b style={{ fontWeight: 600 }}>{f.name}</b>
                    <span className="lane-note" style={{ display: 'block' }}>{f.purpose}</span>
                  </span>
                  <span className="lane-note" style={{ whiteSpace: 'nowrap' }}>{f.files ? plural(f.files, 'file') : 'Empty'}</span>
                </div>
              ))}
            </div>
          )}

          {showForm && (
            <form
              className="stack-sm"
              onSubmit={(e) => {
                e.preventDefault();
                void choose(path.trim());
              }}
            >
              <label className="field">
                <span>Folder on this Mac</span>
                <input ref={pathInput} className="input" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/Library/CloudStorage/GoogleDrive-you@gmail.com/My Drive/Office" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
                <small>The full path of a folder that already exists in your Drive. Bureau adds four folders inside it and never creates the folder itself.</small>
              </label>
              {drive.mounts.length > 0 ? (
                <div className="lane-note">
                  Google Drive is on this Mac at:
                  {drive.mounts.map((m) => (
                    <button key={m} type="button" className="mount-pick" onClick={() => startTyping(m)} title="Start the path with this, then type the folder’s name">
                      {m}
                    </button>
                  ))}
                  Choose one, then add the name of your folder.
                </div>
              ) : (
                <p className="lane-note red">Google Drive for desktop does not seem to be running on this Mac, so there is no Drive to choose a folder in. Open it and sign in, then come back here.</p>
              )}
              <div className="row">
                <button className="btn btn-line" type="submit" disabled={!path.trim() || busy !== null}>
                  {busy === 'folder' ? 'Checking' : 'Use this folder'}
                </button>
                {editing && (
                  <button className="btn btn-quiet" type="button" onClick={() => (setEditing(false), setPath(''))}>
                    Cancel
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </section>

      <section className="panel" id="backup">
        <h2 className="panel-title">Backup</h2>
        <p className="panel-lede">
          Each night Bureau puts one encrypted copy of the whole office into the Backups folder: staff, their folders, the Books, the work list and every conversation. A copy can only be opened with a recovery key, which Bureau shows you once and does not keep.
        </p>
        <div className="stack-sm">
          {backup.problem && (
            <p className={backup.hasKey ? 'lane-note red' : 'empty'} style={{ margin: 0 }}>
              {backup.hasKey ? `Backups cannot run right now. ${backup.problem}` : backup.problem}
            </p>
          )}

          {!backup.hasKey ? (
            <div className="row">
              <button className="btn btn-ink" disabled={busy !== null || !backup.available} onClick={() => void makeKey(false)}>
                {busy === 'key' ? 'Making the key' : 'Create recovery key'}
              </button>
              {backup.available && backup.problem && !/recovery key/i.test(backup.problem) && <span className="lane-note">You can make the key now. Backups start once the Drive folder is in place.</span>}
            </div>
          ) : (
            <>
              <div>
                <div className="lane-row">
                  <span className="lane-text">
                    <b style={{ fontWeight: 600 }}>Last backup</b>
                    {backup.last ? (
                      <span className="lane-note" style={{ display: 'block', overflowWrap: 'anywhere' }}>
                        {longDate(backup.last.at)} at {clock(backup.last.at)}. {backup.last.file}, {bytes(backup.last.bytes)}.
                      </span>
                    ) : (
                      <span className="lane-note" style={{ display: 'block' }}>{busy === 'backup' || backup.running ? 'Making the first one now.' : 'None yet.'}</span>
                    )}
                    {backup.lastError && (
                      <span className="lane-note red" style={{ display: 'block' }}>
                        The last try, {when(backup.lastError.at, t)}, did not work: {backup.lastError.message}
                      </span>
                    )}
                  </span>
                  <button className="btn btn-soft btn-sm" disabled={busy !== null || backup.running || !!backup.problem} onClick={() => void backUp()}>
                    {busy === 'backup' || backup.running ? 'Backing up' : 'Back up now'}
                  </button>
                </div>
                <div className="lane-row">
                  <span className="lane-text">
                    <b style={{ fontWeight: 600 }}>Kept</b>
                    <span className="lane-note" style={{ display: 'block' }}>
                      {backup.kept ? `${plural(backup.kept, 'copy', 'copies')}${backup.oldestAt && backup.kept > 1 ? `, the oldest from ${longDate(backup.oldestAt)}` : ''}. ` : 'No copies in the folder. '}
                      Bureau keeps the newest of each of the last 14 days and of each of the last 12 months.
                    </span>
                  </span>
                </div>
                <div className="lane-row">
                  <span className="lane-text">
                    <b style={{ fontWeight: 600 }}>Recovery key</b>
                    <span className="lane-note" style={{ display: 'block' }}>
                      {backup.keyCreatedAt ? `Made ${longDate(backup.keyCreatedAt)}. ` : ''}
                      You hold it; Bureau keeps only the public half, which ends in <span className="key-ending">{backup.keyEnding}</span>. That ending is there to tell one key from another.
                    </span>
                    {!confirmReplace && (
                      <button className="btn btn-quiet btn-sm" style={{ padding: 0, marginTop: 2 }} disabled={busy !== null} onClick={() => setConfirmReplace(true)}>
                        Replace recovery key
                      </button>
                    )}
                  </span>
                </div>
              </div>
              {confirmReplace && (
                <div className="callout">
                  <p>
                    A new key locks backups from now on. Every backup made until now can still only be opened with the old key, so keep that one too. Replace it if the old key may have been seen by someone else, or if you have lost it.
                  </p>
                  <button className="btn btn-line" disabled={busy !== null} onClick={() => void makeKey(true)}>
                    {busy === 'key' ? 'Making the key' : 'Make a new key'}
                  </button>
                  <button className="btn btn-quiet" onClick={() => setConfirmReplace(false)}>
                    Cancel
                  </button>
                </div>
              )}
            </>
          )}

          <p className="lane-note" style={{ margin: 0 }}>
            To rebuild an office from a backup, run <code className="inline-code">pnpm office:restore &lt;archive&gt; &lt;new folder&gt;</code> in the Bureau project folder and paste the recovery key when asked. The README has the steps.
          </p>
        </div>
      </section>

      {shown && <RecoveryKeyDialog recoveryKey={shown.recoveryKey} replaced={shown.replaced} onDone={keySaved} />}
    </>
  );
}

function Devices() {
  const t = useNow(60_000);
  const devices = useLoad<Device[]>(() => api.devices(), []);
  const [code, setCode] = useState<{ code: string; url?: string; expiresAt?: number } | null>(null);
  /** The devices that were paired when the code was made, to notice the one it adds. */
  const before = useRef<Set<string>>(new Set());
  const make = async () => {
    const c = await api.deviceCode();
    if (!c) return;
    before.current = new Set((devices.data ?? []).map((d) => d.id));
    setCode(c);
  };
  // While a code is showing, keep looking for the device that used it.
  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => {
      if (code.expiresAt && Date.now() > code.expiresAt) setCode(null);
      else devices.reload();
    }, 3000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  useEffect(() => {
    if (!code) return;
    const added = (devices.data ?? []).find((d) => !before.current.has(d.id) && !d.current);
    if (!added) return;
    setCode(null);
    toast(`${added.label} has been added.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.data]);
  return (
    <div className="stack-sm">
      {devices.error && <p className="empty">{devices.error}</p>}
      <div>
        {(devices.data ?? []).map((d) => (
          <div key={d.id} className="lane-row" style={{ alignItems: 'center' }}>
            <span className="lane-text">
              <b style={{ fontWeight: 600 }}>{d.label}</b>
              {d.current && ', this one'}
              <span className="lane-note" style={{ display: 'block' }}>Last seen {when(d.lastSeenAt, t)}</span>
            </span>
            {!d.current && (
              <button className="btn btn-soft btn-sm" onClick={() => void api.revokeDevice(d.id).then(devices.reload)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {code ? (
        <div className="stack-sm">
          <div className="code" aria-label="Pairing code">
            {code.code}
          </div>
          <p className="panel-lede" style={{ margin: 0 }}>
            Open Bureau on the other device and type this code. It works once, for ten minutes.
            {code.url && (
              <>
                {' '}
                Or open this link there: <span style={{ overflowWrap: 'anywhere', color: 'var(--ink)' }}>{code.url}</span>
              </>
            )}
          </p>
        </div>
      ) : (
        <div className="row">
          <button className="btn btn-line" onClick={() => void make()}>
            Add a device
          </button>
        </div>
      )}
    </div>
  );
}

const CONNECTOR_STATE: Record<Connector['status'], string> = {
  connected: 'Connected',
  'needs-auth': 'Needs you to sign in to it again at claude.ai',
  failed: 'Not responding',
  pending: 'Still connecting',
  disabled: 'Switched off',
};

/** The Claude account staff run on, and the apps connected to it. */
function ConnectedApps() {
  const [d, setD] = useState<EngineInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const check = (fresh: boolean) => {
    setChecking(true);
    setProblem(null);
    api
      .engineInfo(fresh)
      .then(setD)
      .catch((e) => setProblem(e instanceof Error ? e.message : 'Could not ask Claude Code.'))
      .finally(() => setChecking(false));
  };
  useEffect(() => check(false), []);
  if (problem) return <p className="empty">{problem}</p>;
  if (!d) return <p className="empty">Asking Claude Code. This takes a few seconds.</p>;
  return (
    <div className="stack-sm">
      {d.error ? (
        <p className="empty">
          <b>Claude Code did not answer.</b> {d.error}
        </p>
      ) : d.engine === 'demo' ? (
        <p className="panel-lede" style={{ margin: 0, color: 'var(--ink)' }}>
          This is the demo office. The apps below are examples, and no Claude account is in use.
        </p>
      ) : (
        <p className="panel-lede" style={{ margin: 0, color: 'var(--ink)' }}>
          {d.account?.email ? `Signed in as ${d.account.email}` : 'Signed in'}
          {d.account?.plan ? `, ${d.account.plan}` : ''}.
        </p>
      )}
      <div>
        {d.connectors.map((c) => (
          <div key={c.name} className="lane-row" style={{ alignItems: 'center' }}>
            <span className="lane-text">
              <b style={{ fontWeight: 600 }}>{c.name}</b>
              <span className="lane-note" style={{ display: 'block', color: c.status === 'connected' ? undefined : 'var(--red)' }}>
                {CONNECTOR_STATE[c.status]}
                {c.status === 'connected' && c.tools > 0 ? `, ${c.tools} things staff can do with it` : ''}
              </span>
            </span>
          </div>
        ))}
        {!d.error && d.connectors.length === 0 && (
          <p className="empty">
            <b>No apps are connected to this Claude account.</b> Until Gmail, Google Calendar and Drive are added, staff can only work with files on this Mac and the web.
          </p>
        )}
      </div>
      <div className="row">
        <button className="btn btn-line" onClick={() => check(true)} disabled={checking}>
          {checking ? 'Checking' : 'Check again'}
        </button>
      </div>
    </div>
  );
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Notifications for this device, so a slip reaches the owner wherever they are. */
function Notifications() {
  const native = inNativeApp();
  const info = useLoad<PushInfo>(() => api.pushInfo(), []);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const secure = location.protocol === 'https:';
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (native || !supported) return;
    let live = true;
    void navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (live) setOn(!!sub && Notification.permission === 'granted');
    });
    return () => {
      live = false;
    };
  }, [native, supported]);

  const test = async () => {
    const res = await api.pushTest();
    if (res !== undefined) toast('Sent. It should arrive in a moment.');
  };

  if (nativePlatform() === 'macos') {
    return (
      <p className="panel-lede" style={{ margin: 0 }}>
        This Mac app tells you when a slip arrives, for as long as it is running. It stays in the menu bar when you close the window, and a plain action can be signed from the notification itself. Its own settings are under Bureau, then Settings, in the menu bar.
      </p>
    );
  }
  if (native) {
    return (
      <div className="stack-sm">
        <p className="panel-lede" style={{ margin: 0 }}>
          {info.data?.apnsConfigured
            ? 'This app gets notifications through Apple, sent straight from your Mac. A plain action can be signed from the notification itself.'
            : 'This app is ready, but the Mac cannot send to it yet. It needs your Apple Push key, which takes about five minutes to set up once: see apps/ios/README.md.'}
        </p>
        {info.data?.apnsConfigured && (
          <div className="row">
            <button className="btn btn-line" onClick={() => void test()}>
              Send a test
            </button>
          </div>
        )}
      </div>
    );
  }
  if (!supported) {
    return (
      <p className="panel-lede" style={{ margin: 0 }}>
        This browser cannot receive notifications as it is. On an iPhone or iPad, add Bureau to the Home Screen first (Share, then Add to Home Screen) and open it from there.
      </p>
    );
  }
  if (!secure) {
    return (
      <p className="panel-lede" style={{ margin: 0 }}>
        Notifications need the secure address. Turn on remote access on the Mac, open Bureau through its https address, and switch them on there.
      </p>
    );
  }

  const turnOn = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') {
        toast('Notifications are blocked for this site. Allow them in the browser’s settings and try again.');
        return;
      }
      const key = info.data?.publicKey ?? (await api.pushInfo()).publicKey;
      if (!key) throw new Error('no key');
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
      const res = await api.pushSubscribe(sub.toJSON());
      if (res !== undefined) {
        setOn(true);
        toast('Notifications are on for this device.');
      }
    } catch {
      toast('Could not turn notifications on. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };
  const turnOff = async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setOn(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-sm">
      <p className="panel-lede" style={{ margin: 0 }}>
        {on ? 'On for this device. You are told when a slip needs your signature or someone has a question.' : 'Off for this device. Turn them on to be told when a slip needs your signature.'}
      </p>
      <div className="row">
        {on ? (
          <>
            <button className="btn btn-line" onClick={() => void test()} disabled={busy}>
              Send a test
            </button>
            <button className="btn btn-quiet" onClick={() => void turnOff()} disabled={busy}>
              Turn off
            </button>
          </>
        ) : (
          <button className="btn btn-blue" onClick={() => void turnOn()} disabled={busy || on === null}>
            Turn on notifications
          </button>
        )}
      </div>
    </div>
  );
}

/** The ways a document or a request reaches the office without being typed in. */
function WaysIn() {
  const settings = useStore((s) => s.settings);
  const staff = useStaffList();
  const chief = useChief();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.engineInfo().then((d) => { if (live) setEmail(d.account?.email ?? null); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  // Whoever has a duty about the inbox reads forwarded mail; failing that, whoever may read mail at all.
  const duties = useStore((s) => s.duties);
  const inbox = Object.values(duties).filter((d) => /inbox|mail/i.test(d.title)).sort((a, b) => Number(b.enabled && !!b.cron) - Number(a.enabled && !!a.cron))[0];
  const reader = (inbox && staff.find((s) => s.id === inbox.staffId)) ?? staff.find((s) => (s.authority['mail.read'] ?? 0) >= 1 && !s.isChief) ?? staff.find((s) => (s.authority['mail.read'] ?? 0) >= 1);
  const scheduled = !!inbox && inbox.enabled && !!inbox.cron;
  const forward = email && email.includes('@') ? email.replace('@', '+office@') : 'yourname+office@gmail.com';
  return (
    <section className="panel" id="ways">
      <h2 className="panel-title">Getting things to the office</h2>
      <div>
        <div className="lane-row">
          <span className="lane-text">
            <b style={{ fontWeight: 600 }}>Attach to a message</b>
            <span className="lane-note" style={{ display: 'block' }}>
              Use the plus beside the message box in anyone’s thread, on a phone or a computer. Up to 10 files of 25 MB each. They go into that person’s own folder.
            </span>
          </span>
        </div>
        <div className="lane-row">
          <span className="lane-text">
            <b style={{ fontWeight: 600 }}>Leave it in Drop here</b>
            <span className="lane-note" style={{ display: 'block' }}>
              The office looks in Drop here, in the Drive folder below, once a minute. A file is picked up when it has finished copying, and {chief?.name ?? 'the chief of staff'} deals with it or hands it on.
            </span>
            <label className="check" style={{ marginTop: 8, fontSize: 14 }}>
              <input type="checkbox" checked={settings?.watchDrop !== false} onChange={(e) => void api.saveSettings({ watchDrop: e.target.checked })} />
              Hand whatever lands in Drop here to {chief?.name ?? 'the chief of staff'}
            </label>
          </span>
        </div>
        <div className="lane-row">
          <span className="lane-text">
            <b style={{ fontWeight: 600 }}>Forward a message</b>
            <span className="lane-note" style={{ display: 'block' }}>
              Forward it to <b style={{ fontWeight: 600, color: 'var(--ink)' }}>{forward}</b> and write what you want above it. {scheduled
                ? `${reader?.name ?? 'Whoever reads your inbox'} picks it up on the next pass through the inbox, so it is not instant; to hurry it, tell ${reader?.name ?? 'them'} to check the inbox.`
                : `No duty that reads the inbox is switched on, so nothing picks it up until you tell ${reader?.name ?? 'someone who may read your mail'} to check the inbox.`}
            </span>
          </span>
        </div>
      </div>
      <p className="panel-lede" style={{ margin: 0 }}>
        Whatever arrives these ways counts as outside material. Staff read it as information, and it cannot lead them to send mail, change your calendar or run anything on this Mac without your signature.
      </p>
    </section>
  );
}

/** A whole number typed into a field, saved when the field is left or Enter is pressed. */
function NumberField({ value, min, max, disabled, unit, onSave }: { value: number; min: number; max: number; disabled?: boolean; unit: string; onSave: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  return (
    <span className="usage-limit">
      <input
        className="input" type="number" inputMode="numeric" min={min} max={max} disabled={disabled} value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        onBlur={() => {
          const n = Math.round(Number(draft));
          if (draft.trim() && Number.isFinite(n) && n >= min && n <= max && n !== value) onSave(n);
          else setDraft(String(value));
        }}
      />
      <span>{unit}</span>
    </span>
  );
}

/** How much of the week's allowance is used, and the point past which scheduled duties wait. */
function UsageLimits() {
  const settings = useStore((s) => s.settings);
  const usage = usePlanUsage();
  const now = useNow(30_000);
  const guard = usageGuard(settings);
  const [reading, setReading] = useState(false);
  const save = (patch: Partial<UsageGuard>) => void api.saveSettings({ usageGuard: { ...guard, ...patch } });
  const week = usage?.available ? weekReading(usage, now) : null;

  return (
    <section className="panel" id="usage">
      <h2 className="panel-title">Claude usage</h2>
      <p className="panel-lede">
        The office runs on your Claude plan and shares its weekly allowance with everything else you do on that account. This is the plan’s own figure{settings?.engine === 'demo' ? ' (made up here, because this is the demo engine)' : ''}.
      </p>
      {!usage && <p className="empty" style={{ fontSize: 14 }}>Reading the figure.</p>}
      {usage && !usage.available && <p className="empty" style={{ fontSize: 14 }}>This engine does not report plan usage.</p>}
      {usage && week && (
        <div className="usage-table">
          <div className={`usage-table-row${week.over ? ' over' : ''}`}>
            <span className="usage-table-label">This week</span>
            <span className="usage-table-pct">{week.used}%</span>
            <Bar used={week.used} limit={week.limit} over={week.over} />
            <span className="usage-table-reset">
              {usage.week?.resetsAt ? `${week.reset}, ${longDate(usage.week.resetsAt)} at ${clock(usage.week.resetsAt)}` : week.reset}
            </span>
          </div>
        </div>
      )}
      {usage?.available && (
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          <button
            className="btn btn-soft btn-sm" disabled={reading}
            onClick={() => { setReading(true); void reloadPlanUsage(true).finally(() => setReading(false)); }}
          >
            {reading ? 'Reading' : 'Read again'}
          </button>
          <span className="aside-meta">
            {usage.error ? `Could not be read just now: ${usage.error}` : usage.checkedAt ? `Read ${clock(usage.checkedAt)}. Reading costs no usage.` : ''}
          </span>
        </div>
      )}
      {usage?.holding && (
        <p className="usage-holding">
          Scheduled duties are on hold: {Math.round(usage.holding.used)}% of the week is used and the limit is {usage.holding.limit}%.
        </p>
      )}
      <label className="check">
        <input type="checkbox" checked={guard.on} onChange={(e) => save({ on: e.target.checked })} />
        Hold scheduled duties when the week’s usage reaches a limit
      </label>
      <label className="field">
        <span>Hold when the week reaches</span>
        <NumberField value={guard.week} min={1} max={100} disabled={!guard.on} unit="% used" onSave={(n) => save({ week: n })} />
      </label>
      <p className="panel-lede" style={{ margin: 0 }}>
        Only duties on a schedule are held. Anything you ask for yourself, and Run now, always goes ahead. A held run is skipped, not saved up: the duty runs at its next scheduled time once usage is back under the limit.
      </p>
    </section>
  );
}

/** How full each person's conversation is, and the size at which Claude Code compacts it. */
function ConversationSize() {
  const settings = useStore((s) => s.settings);
  const staff = useStaffList();
  const window = compactAt(settings);
  const known = staff.map((s) => contextReading(s.context)).find((r) => r);
  const reserve = known ? known.window - known.compactsAt : null;

  return (
    <section className="panel" id="context">
      <h2 className="panel-title">Conversation size</h2>
      <p className="panel-lede">
        Each member of staff keeps one running conversation. When it nears the size below, Claude Code summarizes the earlier part to make room, which is called compaction, and some detail is lost. Notes, the Library and the Books are not touched by it.
      </p>
      <div className="usage-table">
        {staff.map((s) => {
          const r = contextReading(s.context);
          return (
            <div key={s.id} className="usage-table-row">
              <span className="usage-table-label">{s.name}</span>
              <span className="usage-table-pct">{r ? `${r.pct}%` : ''}</span>
              {r ? <Bar used={r.pct} /> : <span />}
              <span className="usage-table-reset">
                {r ? `${tokens(r.left)} until compaction. Holds ${tokens(r.used)}, compacts at ${tokens(r.compactsAt)}.` : 'No conversation yet'}
              </span>
            </div>
          );
        })}
      </div>
      <label className="field">
        <span>Compact a conversation at</span>
        <NumberField
          value={Math.round(window / 1000)} min={COMPACT_AT_MIN / 1000} max={COMPACT_AT_MAX / 1000} unit="thousand tokens"
          onSave={(n) => void api.saveSettings({ compactAt: n * 1000 })}
        />
        <small>
          From {COMPACT_AT_MIN / 1000} to {COMPACT_AT_MAX / 1000}. {reserve ? `Claude Code keeps ${tokens(reserve)} in reserve, so compaction starts at ${tokens(window - reserve)}.` : 'Claude Code keeps a little in reserve, so compaction starts slightly before this.'} A change applies from each person’s next piece of work.
        </small>
      </label>
    </section>
  );
}

export function Settings() {
  const settings = useStore((s) => s.settings);
  const staff = useStaffList();
  const hash = useHash();
  const [open, setOpen] = useState<string | null>(null);
  const [owner, setOwner] = useState({ ownerName: settings?.ownerName ?? '', ownerInitials: settings?.ownerInitials ?? '', signatureText: settings?.signatureText ?? '', ownerAbout: settings?.ownerAbout ?? '' });
  const [hire, setHire] = useState({ name: '', role: '', about: '' });
  const [byHand, setByHand] = useState(false);
  const chief = useChief();

  useEffect(() => {
    if (hash.startsWith('#staff-')) setOpen(hash.slice(7));
    const id = hash.slice(1);
    if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, [hash]);
  useEffect(() => {
    if (settings) setOwner({ ownerName: settings.ownerName, ownerInitials: settings.ownerInitials, signatureText: settings.signatureText, ownerAbout: settings.ownerAbout ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.ownerName, settings?.ownerInitials, settings?.signatureText, settings?.ownerAbout]);

  if (!settings) return null;
  const ownerDirty = owner.ownerName !== settings.ownerName || owner.ownerInitials !== settings.ownerInitials || owner.signatureText !== settings.signatureText || owner.ownerAbout !== (settings.ownerAbout ?? '');

  const doHire = async (e: FormEvent) => {
    e.preventDefault();
    const res = await api.hire({ name: hire.name.trim(), role: hire.role.trim(), about: hire.about.trim(), letter: hire.name.trim().slice(0, 1).toUpperCase() });
    if (res === undefined) return;
    setHire({ name: '', role: '', about: '' });
    toast(`${hire.name.trim()} has joined. Everyone starts by drafting.`);
    const id = res?.id ?? res?.staff?.id;
    if (id) navigate(`/settings#staff-${id}`);
  };

  return (
    <div className="page">
      <header>
        <h1 className="page-title">Settings</h1>
        {/* The phone's tabs have no room for these two. */}
        <p className="phone-only flex settings-more">
          <Link to="/library" className="link">
            Library
          </Link>
          <Link to="/week" className="link">
            The week
          </Link>
        </p>
      </header>

      <section className="panel" id="you">
        <h2 className="panel-title">You</h2>
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void api.saveSettings({ ownerName: owner.ownerName.trim(), ownerInitials: owner.ownerInitials.trim().slice(0, 3).toUpperCase(), signatureText: owner.signatureText.trim(), ownerAbout: owner.ownerAbout.trim() });
          }}
        >
          <div className="grid2">
            <label className="field">
              <span>What staff call you</span>
              <input className="input" value={owner.ownerName} onChange={(e) => setOwner({ ...owner, ownerName: e.target.value })} />
            </label>
            <label className="field">
              <span>Initials</span>
              <input className="input" value={owner.ownerInitials} maxLength={3} onChange={(e) => setOwner({ ...owner, ownerInitials: e.target.value })} style={{ width: 96 }} />
            </label>
          </div>
          <label className="field">
            <span>About you</span>
            <textarea
              className="textarea"
              rows={3}
              maxLength={1200}
              value={owner.ownerAbout}
              placeholder="What you do, the tools you use, anything every member of staff should know about you."
              onChange={(e) => setOwner({ ...owner, ownerAbout: e.target.value })}
            />
            <small>Every member of staff is told this before each piece of work.</small>
          </label>
          <label className="field">
            <span>Signature in the script face</span>
            <input className="input" value={owner.signatureText} onChange={(e) => setOwner({ ...owner, signatureText: e.target.value })} />
            <small>Used until you draw your own below.</small>
          </label>
          <div className="row">
            <button className="btn btn-blue" type="submit" disabled={!ownerDirty}>
              Save
            </button>
          </div>
        </form>
      </section>

      <section className="panel" id="signature">
        <h2 className="panel-title">Your signature</h2>
        <p className="panel-lede">Draw it once. It is written out each time you sign a slip.</p>
        <SignaturePad />
      </section>

      <section className="panel" id="signing">
        <h2 className="panel-title">Signing</h2>
        <label className="field" style={{ maxWidth: 280 }}>
          <span>Seconds to undo after signing</span>
          <input className="input" type="number" min={0} max={60} value={settings.undoSeconds} onChange={(e) => void api.saveSettings({ undoSeconds: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })} />
          <small>A signed action waits this long before it goes ahead.</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.checkSlips} onChange={(e) => void api.saveSettings({ checkSlips: e.target.checked })} />
          Have the chief of staff check each slip before it reaches me
        </label>
      </section>

      <UsageLimits />
      <ConversationSize />

      <section className="panel" id="staff">
        <h2 className="panel-title">Staff</h2>
        <div>
          {staff.map((s) => (
            <div key={s.id} id={`staff-${s.id}`}>
              <button className="person-row" onClick={() => setOpen(open === s.id ? null : s.id)} aria-expanded={open === s.id}>
                <Bubble staff={s} />
                <span className="grow">
                  <span className="roster-name" style={{ display: 'block' }}>{s.name}</span>
                  <span className="roster-role" style={{ display: 'block' }}>{s.role}</span>
                </span>
                <span className="link" style={{ fontSize: 13 }}>
                  {open === s.id ? 'Close' : 'Edit'}
                </span>
              </button>
              {open === s.id && <PersonEditor key={s.id} staff={s} />}
            </div>
          ))}
        </div>
      </section>

      <section className="panel" id="hire">
        <h2 className="panel-title">Hire someone</h2>
        <p className="panel-lede">
          Hiring is a conversation with {chief?.name ?? 'your chief of staff'}: you describe the job, {chief?.name ?? 'they'} drafts a profile, starting authority and skills, and you sign when it reads right.
        </p>
        <div className="row">
          <Link to="/hire" className="btn btn-ink">
            Open the hiring desk
          </Link>
          <button className="btn btn-quiet" onClick={() => setByHand(!byHand)} aria-expanded={byHand}>
            {byHand ? 'Hide the short form' : 'Or add someone by hand'}
          </button>
        </div>
        {byHand && <p className="panel-lede" style={{ margin: 0 }}>A person added by hand gets a folder on your Mac, an empty profile and authority to draft only.</p>}
        {byHand && (
        <form className="stack-sm" onSubmit={doHire}>
          <div className="grid2">
            <label className="field">
              <span>Name</span>
              <input className="input" value={hire.name} onChange={(e) => setHire({ ...hire, name: e.target.value })} placeholder="Quill" />
            </label>
            <label className="field">
              <span>Role</span>
              <input className="input" value={hire.role} onChange={(e) => setHire({ ...hire, role: e.target.value })} placeholder="Writing and editing" />
            </label>
          </div>
          <label className="field">
            <span>What this person is for</span>
            <textarea className="textarea" value={hire.about} onChange={(e) => setHire({ ...hire, about: e.target.value })} style={{ minHeight: 64 }} placeholder="Drafts proposals and course material, and edits what I write." />
          </label>
          <div className="row">
            <button className="btn btn-ink" type="submit" disabled={!hire.name.trim() || !hire.role.trim()}>
              Hire
            </button>
          </div>
        </form>
        )}
      </section>

      <section className="panel" id="catalog">
        <h2 className="panel-title">Skills catalog</h2>
        <p className="panel-lede">
          Where skills come from. Nothing is fetched until you press Fetch; then the source is copied from GitHub to this Mac and nothing in it is run. A skill you install is a copy in one person’s folder, so fetching again never changes what is already installed.
        </p>
        <CatalogSources />
      </section>

      <WaysIn />

      <DriveAndBackup />

      <section className="panel" id="apps">
        <h2 className="panel-title">Claude and connected apps</h2>
        <p className="panel-lede">
          Staff reach Gmail, Calendar, Drive and other apps through the connectors on your own Claude account. Add or remove them at claude.ai, under Settings, then Connectors. What each member of staff may do with them is set on the Staff page.
        </p>
        <ConnectedApps />
      </section>

      <section className="panel" id="notifications">
        <h2 className="panel-title">Notifications</h2>
        <Notifications />
      </section>

      <section className="panel" id="devices">
        <h2 className="panel-title">Devices</h2>
        <p className="panel-lede">Phones and computers that may open this office. Each one is paired once with a code from here.</p>
        <Devices />
      </section>

      <section className="panel" id="about">
        <h2 className="panel-title">This office</h2>
        <p className="panel-lede" style={{ margin: 0 }}>
          Running on {settings.hostName}, time zone {settings.timezone}. {settings.engine === 'demo' ? 'Demo engine: staff are simulated and no Claude usage is spent.' : 'Staff run on Claude through the Claude Code installed and signed in on this Mac.'}
        </p>
      </section>
    </div>
  );
}
