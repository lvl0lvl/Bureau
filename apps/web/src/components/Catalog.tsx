import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CatalogPage, CatalogSkill, CatalogSkillDetail } from '@shared/contract.ts';
import { bytes, plural } from '../lib/format.ts';
import { Link } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useLoad } from './bits.tsx';
import { Markdown } from './Markdown.tsx';

/** A panel over the page: centred on a wide screen, a sheet from the bottom on a phone. */
export function Dialog({ title, onClose, children, foot, width }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; width?: number }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="dialog-scrim" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()} style={width ? { maxWidth: width } : undefined}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="btn btn-soft" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {foot && <div className="dialog-foot">{foot}</div>}
      </div>
    </div>
  );
}

/** Where a skill comes from, and whether it carries anything that can be run. */
export function SkillMeta({ source, plugin, scripts }: { source: string; plugin: string | null; scripts: number }) {
  return (
    <span className="skill-meta">
      {source}
      {plugin ? `, ${plugin} plugin` : ''}
      {scripts > 0 && (
        <span className="mark-tag" title="Running a script still needs this person’s authority to run scripts.">
          {plural(scripts, 'script')}
        </span>
      )}
    </span>
  );
}

/** What is inside one catalog skill: its own instructions and the files it carries. */
export function SkillInside({ id, onClose, foot }: { id: string; onClose: () => void; foot?: ReactNode }) {
  const { data, error } = useLoad<CatalogSkillDetail>(() => api.catalogSkill(id), [id]);
  const p = data?.pluginInfo ?? null;
  const extras = p ? [p.connectors.length ? `${plural(p.connectors.length, 'connector')} (${p.connectors.join(', ')})` : '', p.hooks ? 'hooks' : ''].filter(Boolean) : [];
  return (
    <Dialog title={data?.name ?? 'Skill'} onClose={onClose} foot={foot}>
      {error && <p className="empty">{error === 'Could not load this.' ? 'This skill is no longer in the catalog.' : error}</p>}
      {!data && !error && <p className="empty">Opening the skill.</p>}
      {data && (
        <div className="stack">
          <div className="stack-sm">
            <SkillMeta source={data.source} plugin={data.plugin} scripts={data.scripts} />
            <p style={{ fontSize: 15, lineHeight: '22px' }}>{data.description}</p>
            {extras.length > 0 && (
              <p className="skill-note">
                The {p!.name} plugin also carries {extras.join(' and ')}. Bureau installs the skill only; none of that comes with it.
              </p>
            )}
            {data.scripts > 0 && <p className="skill-note">It carries {plural(data.scripts, 'script')}. A script only runs if this person has authority to run scripts, and then under the usual rules.</p>}
          </div>
          <div>
            <h3 className="aside-title" style={{ paddingBottom: 6 }}>
              Files
            </h3>
            {data.fileList.map((f) => (
              <div key={f.path} className="file-row">
                <span className="grow">{f.path}</span>
                {f.script && <span className="mark-tag">script</span>}
                <span className="aside-meta">{bytes(f.size)}</span>
              </div>
            ))}
          </div>
          <div>
            <h3 className="aside-title" style={{ paddingBottom: 6 }}>
              What it tells the person to do
            </h3>
            <div className="msg skill-body">
              <Markdown text={data.body || 'This skill has no instructions of its own.'} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * Search the catalog and pick skills. `taken` are catalog ids already chosen, shown as such.
 * Used by the hiring desk (adds to the draft) and by a person's settings (installs).
 */
export function CatalogBrowser({ title, taken, actionLabel, doneLabel, onPick, onClose }: { title: string; taken: Set<string>; actionLabel: string; doneLabel: string; onPick: (skill: CatalogSkill) => void | Promise<unknown>; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [source, setSource] = useState('');
  const [page, setPage] = useState<CatalogPage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [inside, setInside] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    const t = window.setTimeout(
      () => {
        api
          .catalog(q, { limit: 40, source: source || undefined })
          .then((p) => mine === seq.current && (setPage(p), setProblem(null)))
          .catch((e) => mine === seq.current && setProblem(e instanceof Error ? e.message : 'Could not open the catalog.'));
      },
      q ? 180 : 0,
    );
    return () => clearTimeout(t);
  }, [q, source]);

  const pick = async (s: CatalogSkill) => {
    setBusy(s.id);
    try {
      await onPick(s);
    } finally {
      setBusy(null);
    }
  };
  const unfetched = (page?.sources ?? []).filter((s) => s.fetchedAt === null);
  const withSkills = (page?.sources ?? []).filter((s) => s.skills > 0);

  return (
    <>
      <Dialog title={title} onClose={onClose}>
        <div className="stack-sm">
          <div className="catalog-search">
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by the work: reconcile accounts, draft a contract, spreadsheets" aria-label="Search skills" autoFocus />
            {withSkills.length > 1 && (
              <select className="select" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
                <option value="">All sources</option>
                {withSkills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          {unfetched.length > 0 && (
            <p className="skill-note">
              {unfetched.map((s) => s.label).join(' and ')} {unfetched.length === 1 ? 'has' : 'have'} not been fetched, so {unfetched.length === 1 ? 'its' : 'their'} skills are not listed.{' '}
              <Link to="/settings#catalog" className="link" onClick={onClose}>
                Fetch in Settings
              </Link>
            </p>
          )}
          {problem && <p className="empty">{problem}</p>}
          {page && page.skills.length === 0 && <p className="empty">{q ? `Nothing in the catalog matches “${q}”. Try words for the work itself.` : 'The catalog is empty.'}</p>}
          <div>
            {(page?.skills ?? []).map((s) => {
              const has = taken.has(s.id);
              return (
                <div key={s.id} className="skill-row">
                  <div className="grow">
                    <div className="skill-name">{s.name}</div>
                    <div className="skill-desc clamp">{s.description}</div>
                    <SkillMeta source={s.source} plugin={s.plugin} scripts={s.scripts} />
                  </div>
                  <div className="skill-acts">
                    <button className="btn btn-soft btn-sm" onClick={() => setInside(s.id)}>
                      Look inside
                    </button>
                    <button className="btn btn-line btn-sm" disabled={has || busy === s.id} onClick={() => void pick(s)}>
                      {has ? doneLabel : busy === s.id ? 'Working' : actionLabel}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {page && page.total > page.skills.length && <p className="aside-meta">{page.total - page.skills.length} more match. Search to narrow it down.</p>}
        </div>
      </Dialog>
      {inside && <SkillInside id={inside} onClose={() => setInside(null)} />}
    </>
  );
}
