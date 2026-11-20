import { useEffect } from 'react';
import { Wordmark } from './components/bits.tsx';
import { LevelPicker } from './components/LevelPicker.tsx';
import { Shell } from './components/Shell.tsx';
import { Link, navigate, parseRoute, usePath } from './lib/router.tsx';
import { Desk } from './routes/Desk.tsx';
import { Hire } from './routes/Hire.tsx';
import { Pair } from './routes/Pair.tsx';
import { Calendar } from './routes/Calendar.tsx';
import { Week } from './routes/Week.tsx';
import { Books } from './routes/Records.tsx';
import { ArtifactsPage } from './components/Artifacts.tsx';
import { Settings } from './routes/Settings.tsx';
import { StaffMatrix } from './routes/StaffMatrix.tsx';
import { StaffEdit } from './routes/StaffEdit.tsx';
import { Thread } from './routes/Thread.tsx';
import { Work } from './routes/Work.tsx';
import { boot } from './sync/client.ts';
import { useStore } from './sync/store.ts';

export function App() {
  const phase = useStore((s) => s.phase);
  const conn = useStore((s) => s.conn);
  const path = usePath();
  const route = parseRoute(path);

  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    if (phase === 'ready' && route.name === 'pair') navigate('/', { replace: true });
  }, [phase, route.name]);

  if (phase === 'boot') {
    return (
      <div className="app">
        <div className="boot">
          <div className="stack-sm" style={{ alignItems: 'center' }}>
            <Wordmark />
            {conn === 'offline' && <p className="muted" style={{ fontSize: 14 }}>Cannot reach your Mac. Trying again.</p>}
          </div>
        </div>
      </div>
    );
  }
  if (phase === 'unpaired') return <Pair />;

  let view;
  switch (route.name) {
    case 'thread':
      view = <Thread key={route.staffId} staffId={route.staffId!} />;
      break;
    case 'edit':
      view = <StaffEdit key={route.staffId} staffId={route.staffId!} />;
      break;
    case 'hire':
      view = <Hire />;
      break;
    case 'work':
      view = <Work />;
      break;
    case 'staff':
      view = <StaffMatrix />;
      break;
    case 'books':
      view = <Books />;
      break;
    case 'calendar':
      view = <Calendar />;
      break;
    case 'artifacts':
      view = <ArtifactsPage />;
      break;
    case 'week':
      view = <Week />;
      break;
    case 'settings':
      view = <Settings />;
      break;
    case 'missing':
      view = (
        <div className="page">
          <h1 className="page-title">There is nothing at this address</h1>
          <p className="page-lede">
            <Link to="/" className="link">
              Go to the Desk
            </Link>
          </p>
        </div>
      );
      break;
    default:
      view = <Desk />;
  }

  return (
    <>
      <Shell route={route}>{view}</Shell>
      <LevelPicker />
    </>
  );
}
