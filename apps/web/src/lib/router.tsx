import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

window.addEventListener('popstate', emit);

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search + location.hash) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  emit();
}

export function back(fallback = '/'): void {
  if (history.length > 1) history.back();
  else navigate(fallback);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export function useSearch(): string {
  return useSyncExternalStore(subscribe, () => location.search);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => location.hash);
}

export interface Route {
  name: 'desk' | 'thread' | 'hire' | 'work' | 'staff' | 'books' | 'calendar' | 'artifacts' | 'week' | 'settings' | 'pair' | 'missing';
  staffId?: string;
}

export function parseRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'desk' };
  if (p.startsWith('/t/')) return { name: 'thread', staffId: decodeURIComponent(p.slice(3)) };
  if (p === '/hire') return { name: 'hire' };
  if (p === '/work') return { name: 'work' };
  if (p === '/staff') return { name: 'staff' };
  if (p === '/books') return { name: 'books' };
  if (p === '/calendar') return { name: 'calendar' };
  if (p === '/artifacts' || p === '/library') return { name: 'artifacts' };
  if (p === '/week') return { name: 'week' };
  if (p === '/settings') return { name: 'settings' };
  if (p === '/pair') return { name: 'pair' };
  return { name: 'missing' };
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={click} {...rest} />;
}
