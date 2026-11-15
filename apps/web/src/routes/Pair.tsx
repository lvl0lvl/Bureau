import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Wordmark } from '../components/bits.tsx';
import { navigate } from '../lib/router.tsx';
import { api } from '../sync/client.ts';
import { useStore } from '../sync/store.ts';

function guessLabel(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser && !/iPhone|iPad|Android/.test(ua) ? `${device}, ${browser}` : device;
}

export function Pair() {
  const session = useStore((s) => s.session);
  const fromLink = new URLSearchParams(location.search).get('code') ?? '';
  const [code, setCode] = useState(fromLink);
  const [label, setLabel] = useState(guessLabel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || code.trim().length < 4) return;
    setBusy(true);
    setError(null);
    const problem = await api.pair(code, label.trim() || guessLabel());
    setBusy(false);
    if (problem) setError(problem);
    else navigate('/', { replace: true });
  };

  // A pairing link carries the code: use it straight away.
  useEffect(() => {
    if (fromLink && !tried.current) {
      tried.current = true;
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <div className="center">
        <form className="pair" onSubmit={submit}>
          <Wordmark />
          <div className="stack-sm">
            <h1>Pair this device</h1>
            <p>
              This is the office running on {session?.hostName ?? 'your Mac'}
              {session?.ownerName ? `, for ${session.ownerName}` : ''}. To open it here, get a code from a device that is already paired (Settings, Devices) or run <b style={{ color: 'var(--ink)' }}>pnpm pair</b> on the Mac.
            </p>
          </div>
          <label className="field">
            <span>Pairing code</span>
            <input className="input big" value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ''))} autoFocus autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={12} aria-invalid={!!error} />
          </label>
          <label className="field">
            <span>Name for this device</span>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-blue btn-lg" type="submit" disabled={busy || code.trim().length < 4}>
            {busy ? 'Pairing' : 'Pair this device'}
          </button>
        </form>
      </div>
    </div>
  );
}
