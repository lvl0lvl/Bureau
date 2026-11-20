import { BackIcon, Bubble } from '../components/bits.tsx';
import { Link } from '../lib/router.tsx';
import { useStore } from '../sync/store.ts';
import { PersonEditor } from './Settings.tsx';

/** One person's own edit page, reached from their details: permissions, profile and the rest. */
export function StaffEdit({ staffId }: { staffId: string }) {
  const staff = useStore((s) => s.staff[staffId]);
  if (!staff || staff.retired) {
    return (
      <div className="page">
        <h1 className="page-title">No one by that name</h1>
        <p className="page-lede">
          They may have been retired. <Link to="/staff">See everyone</Link>.
        </p>
      </div>
    );
  }
  return (
    <div className="page staff-edit-page">
      <header className="staff-edit-head">
        <Link to={`/t/${encodeURIComponent(staff.id)}`} className="btn btn-soft staff-edit-back">
          <BackIcon />
          <span>{staff.name}</span>
        </Link>
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <Bubble staff={staff} size={40} working={false} />
          <div>
            <h1 className="page-title" style={{ margin: 0 }}>Edit {staff.name}</h1>
            <p className="page-lede" style={{ margin: 0 }}>{staff.role}</p>
          </div>
        </div>
      </header>
      <PersonEditor key={staff.id} staff={staff} page />
    </div>
  );
}
