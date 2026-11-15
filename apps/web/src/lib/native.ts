/**
 * The bridge the iPhone and Mac apps inject (see apps/ios/Bureau/OfficeWebView.swift and
 * apps/mac/Bureau/OfficeController.swift). In a browser it is
 * simply absent and everything here does nothing.
 */
interface BureauNative {
  platform: string;
  confirm(reason: string): Promise<boolean>;
  haptic(kind: 'light' | 'medium' | 'success' | 'warning'): void;
  ready(): void;
}

declare global {
  interface Window {
    bureauNative?: BureauNative;
  }
}

export const inNativeApp = (): boolean => !!window.bureauNative;

/** 'ios', 'macos', or null in a browser. */
export const nativePlatform = (): string | null => window.bureauNative?.platform ?? null;

/** Face ID (or the passcode) before a signature. Always true in a browser. */
export async function confirmSignature(reason: string): Promise<boolean> {
  const n = window.bureauNative;
  if (!n) return true;
  try {
    return await n.confirm(reason);
  } catch {
    return false;
  }
}

export function haptic(kind: 'light' | 'medium' | 'success' | 'warning' = 'light'): void {
  try {
    window.bureauNative?.haptic(kind);
  } catch {
    /* not in the app */
  }
}

export function nativeReady(): void {
  try {
    window.bureauNative?.ready();
  } catch {
    /* not in the app */
  }
}
