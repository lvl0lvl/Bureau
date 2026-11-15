import type { CSSProperties } from 'react';
import { useStore } from '../sync/store.ts';

/**
 * The owner's signature: the hand-drawn strokes when one has been saved, otherwise a script face.
 * With `animate`, it is written out stroke by stroke.
 */
export function Signature({ animate, large }: { animate?: boolean; large?: boolean }) {
  const signature = useStore((s) => s.settings?.signature ?? null);
  const text = useStore((s) => s.settings?.signatureText || s.settings?.ownerName || '');

  if (signature && signature.paths.length) {
    let delay = 0;
    return (
      <span className={`sig${large ? ' lg' : ''}`} role="img" aria-label="Signed">
        <svg className={`sig-svg${animate ? ' animate' : ''}`} viewBox={`0 0 ${signature.width} ${signature.height}`} preserveAspectRatio="xMinYMid meet">
          {signature.paths.map((d, i) => {
            // Longer strokes take longer; the pen lifts briefly between strokes.
            const seconds = Math.min(0.8, Math.max(0.12, d.length / 1100));
            const style = { '--d': `${seconds}s`, '--delay': `${delay}s` } as CSSProperties;
            delay += seconds + 0.05;
            return <path key={i} d={d} pathLength={1} style={style} />;
          })}
        </svg>
      </span>
    );
  }
  return (
    <span className={`sig${large ? ' lg' : ''}`} role="img" aria-label="Signed">
      <span className={`sig-text${animate ? ' animate' : ''}`}>{text}</span>
    </span>
  );
}
