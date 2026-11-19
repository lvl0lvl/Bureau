/**
 * A reader for Fountain, the plain-text screenplay format: enough of it to lay a script out the
 * way it prints. Title page, scene headings, action, characters, parentheticals, dialogue,
 * transitions, centred lines, page breaks. Notes, boneyard, sections and synopses are left out,
 * as they are when a script is printed.
 */

export type FountainEl =
  | { t: 'title'; fields: { key: string; value: string }[] }
  | { t: 'scene'; text: string; number?: string }
  | { t: 'action'; text: string }
  | { t: 'centered'; text: string }
  | { t: 'transition'; text: string }
  | { t: 'dialogue'; character: string; dual: boolean; lines: { t: 'paren' | 'line' | 'lyric'; text: string }[] }
  | { t: 'break' };

const SCENE = /^(?:\.(?!\.)|(?:INT|EXT|EST|INT\.?\/EXT|I\/E)[.\s])/i;
const TITLE_KEY = /^([A-Za-z][A-Za-z ]{0,30}):\s*(.*)$/;

const isUpper = (s: string) => /\p{Lu}/u.test(s) && s === s.toUpperCase();

export function parseFountain(source: string): FountainEl[] {
  let text = source.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '');
  const out: FountainEl[] = [];

  // Title page: "Key: value" lines at the very top, up to the first blank line.
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (TITLE_KEY.test(firstLine) && !SCENE.test(firstLine)) {
    const end = text.search(/\n\s*\n/);
    const block = end === -1 ? text : text.slice(0, end);
    const fields: { key: string; value: string }[] = [];
    for (const line of block.split('\n')) {
      const m = TITLE_KEY.exec(line);
      if (m && !/^\s/.test(line)) fields.push({ key: m[1]!.trim(), value: m[2]!.trim() });
      else if (fields.length) fields[fields.length - 1]!.value += `${fields[fields.length - 1]!.value ? '\n' : ''}${line.trim()}`;
    }
    if (fields.length) {
      out.push({ t: 'title', fields });
      text = end === -1 ? '' : text.slice(end);
    }
  }

  const lines = text.split('\n');
  let action: string[] = [];
  const flush = () => {
    while (action.length && !action[action.length - 1]!.trim()) action.pop();
    if (action.length) out.push({ t: 'action', text: action.join('\n') });
    action = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const blankBefore = i === 0 || !lines[i - 1]!.trim();
    const next = lines[i + 1];
    const blankAfter = next === undefined || !next.trim();

    if (!line) {
      if (action.length) action.push('');
      continue;
    }
    // Left out when printed.
    if (/^#/.test(line) || /^=(?!==)/.test(line)) { flush(); continue; }
    if (/^={3,}$/.test(line)) { flush(); out.push({ t: 'break' }); continue; }
    if (line.startsWith('!')) { action.push(raw.replace(/^\s*!/, '')); continue; }

    if (blankBefore && SCENE.test(line)) {
      flush();
      const m = /\s*#([^#]+)#\s*$/.exec(line);
      const heading = (m ? line.slice(0, m.index) : line).replace(/^\./, '').trim();
      out.push({ t: 'scene', text: heading.toUpperCase(), ...(m ? { number: m[1]!.trim() } : {}) });
      continue;
    }
    if (line.startsWith('>') && line.endsWith('<')) {
      flush();
      out.push({ t: 'centered', text: line.slice(1, -1).trim() });
      continue;
    }
    if (line.startsWith('>') || (blankBefore && blankAfter && isUpper(line) && /TO:$/.test(line))) {
      flush();
      out.push({ t: 'transition', text: line.replace(/^>\s*/, '').toUpperCase() });
      continue;
    }

    // A character: a line in capitals (or forced with @) after a blank line, with words under it.
    const forced = line.startsWith('@');
    const name = forced ? line.slice(1) : line;
    const bare = name.replace(/\(.*?\)/g, '').replace(/\^$/, '').trim();
    if (blankBefore && !blankAfter && (forced || (isUpper(bare) && /\p{L}/u.test(bare) && !/[.!?]$/.test(bare) && bare.length <= 40))) {
      flush();
      const dual = name.trimEnd().endsWith('^');
      const said: { t: 'paren' | 'line' | 'lyric'; text: string }[] = [];
      while (i + 1 < lines.length && lines[i + 1]!.trim()) {
        i += 1;
        const l = lines[i]!.trim();
        if (/^\(.*\)$/.test(l)) said.push({ t: 'paren', text: l });
        else if (l.startsWith('~')) said.push({ t: 'lyric', text: l.slice(1).trim() });
        else if (said.length && said[said.length - 1]!.t === 'line') said[said.length - 1]!.text += `\n${l}`;
        else said.push({ t: 'line', text: l });
      }
      out.push({ t: 'dialogue', character: name.replace(/\^$/, '').trim(), dual, lines: said });
      continue;
    }

    action.push(raw.replace(/^ {0,3}(?=\S)/, '').replace(/\t/g, '    '));
  }
  flush();
  return out;
}

/** Emphasis inside a line: ***bold italic***, **bold**, *italic*, _underline_. */
export type Span = { text: string; b?: boolean; i?: boolean; u?: boolean };

export function spans(text: string): Span[] {
  const out: Span[] = [];
  const re = /(\\[*_])|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1]) out.push({ text: m[1].slice(1) });
    else if (m[2]) out.push({ text: m[2], b: true, i: true });
    else if (m[3]) out.push({ text: m[3], b: true });
    else if (m[4]) out.push({ text: m[4], i: true });
    else if (m[5]) out.push({ text: m[5], u: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}
