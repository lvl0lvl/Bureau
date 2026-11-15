import { memo, type ReactNode } from 'react';

/** A small, safe subset of Markdown: paragraphs, lists, headings, code, bold, links. No HTML is ever injected. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|https?:\/\/[^\s)]+[^\s).,;:!?])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}:${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('[')) {
      const close = tok.indexOf('](');
      out.push(
        <a key={key} href={tok.slice(close + 2, -1)} target="_blank" rel="noreferrer noopener">
          {tok.slice(1, close)}
        </a>,
      );
    } else
      out.push(
        <a key={key} href={tok} target="_blank" rel="noreferrer noopener">
          {tok}
        </a>,
      );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function lines(text: string, keyBase: string): ReactNode[] {
  const parts = text.split('\n');
  const out: ReactNode[] = [];
  parts.forEach((line, i) => {
    if (i) out.push(<br key={`${keyBase}:br${i}`} />);
    out.push(...inline(line, `${keyBase}:${i}`));
  });
  return out;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const src = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let k = 0;
  while (i < src.length) {
    const line = src[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < src.length && !src[i]!.startsWith('```')) code.push(src[i++]!);
      i++;
      blocks.push(
        <pre key={k++}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<h4 key={k++}>{inline(heading[1]!, `h${k}`)}</h4>);
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const test = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < src.length && (test.test(src[i]!) || (/^\s{2,}\S/.test(src[i]!) && items.length))) {
        if (test.test(src[i]!)) items.push(src[i]!.replace(test, ''));
        else items[items.length - 1] += `\n${src[i]!.trim()}`;
        i++;
      }
      const lis = items.map((it, n) => <li key={n}>{lines(it, `l${k}:${n}`)}</li>);
      blocks.push(ordered ? <ol key={k++}>{lis}</ol> : <ul key={k++}>{lis}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < src.length && src[i]!.trim() && !src[i]!.startsWith('```') && !bullet.test(src[i]!) && !numbered.test(src[i]!) && !/^#{1,4}\s/.test(src[i]!)) para.push(src[i++]!);
    blocks.push(<p key={k++}>{lines(para.join('\n'), `p${k}`)}</p>);
  }
  return <>{blocks}</>;
});
