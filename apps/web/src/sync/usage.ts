import { useEffect, useState } from 'react';
import type { PlanUsage } from '@shared/contract.ts';
import { api } from './client.ts';
import { useStore } from './store.ts';

/**
 * How much of the Claude plan is used. One copy for the whole page, read again each minute:
 * the office itself re-reads it from Claude every ten minutes and after each turn.
 */
let current: PlanUsage | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(u: PlanUsage | null) => void>();

export async function reloadPlanUsage(fresh = false): Promise<void> {
  try {
    current = await api.planUsage(fresh);
    for (const fn of listeners) fn(current);
  } catch { /* keep what we have; the next minute tries again */ }
}

export function usePlanUsage(): PlanUsage | null {
  const [usage, setUsage] = useState(current);
  // A changed limit changes whether duties are held, so read again when Settings change.
  const guard = useStore((s) => JSON.stringify(s.settings?.usageGuard ?? null));
  useEffect(() => {
    listeners.add(setUsage);
    if (!timer) {
      void reloadPlanUsage();
      timer = setInterval(() => { if (document.visibilityState !== 'hidden') void reloadPlanUsage(); }, 60_000);
    }
    return () => { listeners.delete(setUsage); };
  }, []);
  useEffect(() => { if (current) void reloadPlanUsage(); }, [guard]);
  return usage;
}
