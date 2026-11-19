/**
 * Themes. A theme is a look for this device only: it is kept in this browser, not in the
 * office, so a phone and a Mac can differ. The colours here are only for the previews in
 * Settings and for the browser's own bar; the themes themselves are in styles/themes.css.
 * The first lines of index.html set the theme before anything is drawn and repeat the
 * `ground` colours: keep the two in step.
 */
export interface Theme {
  id: string;
  name: string;
  note: string;
  ground: string;
  panel: string;
  ink: string;
  owner: string;
  needs: string;
  working: string;
  font: string;
  radius: number;
}

export const THEMES: readonly Theme[] = [
  { id: 'drafting', name: 'Drafting table', note: 'White film, black lead, blueprint blue.', ground: '#ffffff', panel: '#ffffff', ink: '#000000', owner: '#1d3fe3', needs: '#e0362c', working: '#ffe14d', font: "'Archivo Variable', sans-serif", radius: 6 },
  { id: 'graph', name: 'Graph paper', note: 'Square corners, typewriter letters, blue and lime.', ground: '#ffffff', panel: '#ffffff', ink: '#0a0a0a', owner: '#1c3cff', needs: '#f0341f', working: '#c9f23f', font: "'JetBrains Mono Variable', monospace", radius: 0 },
  { id: 'night', name: 'Night shift', note: 'Dark slate and frosted glass.', ground: '#0e1626', panel: '#1b2639', ink: '#eef2f8', owner: '#62adff', needs: '#ff8a3d', working: '#25b6cc', font: "'Inter Variable', sans-serif", radius: 12 },
  { id: 'control', name: 'Control room', note: 'Amber on black, like an old terminal.', ground: '#060500', panel: '#060500', ink: '#f4b92f', owner: '#fff1c9', needs: '#ff5a36', working: '#f4b92f', font: "'IBM Plex Mono', monospace", radius: 0 },
  { id: 'stationery', name: 'Stationery', note: 'Soft paper colours and round corners.', ground: '#f4f4f1', panel: '#ffffff', ink: '#1f1f27', owner: '#1f8553', needs: '#dc3f4e', working: '#fbd67a', font: "'Nunito Variable', sans-serif", radius: 14 },
];

const KEY = 'bureau.theme';
const DEFAULT = 'drafting';

export function currentTheme(): string {
  try {
    const id = localStorage.getItem(KEY);
    return THEMES.some((t) => t.id === id) ? id! : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function apply(id: string): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]!;
  if (theme.id === DEFAULT) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.ground);
}

export function setTheme(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private window: the theme lasts until the page is closed */
  }
  apply(id);
}
