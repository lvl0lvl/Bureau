const DAY = 86_400_000;

/** "8:12 am" */
export function clock(ms: number): string {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? 'am' : 'pm';
  h = h % 12 || 12;
  return `${h}:${m < 10 ? '0' : ''}${m} ${ap}`;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Friday 13 November 2026" */
export function longDate(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Fri 13 Nov" */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAY[d.getDay()]!.slice(0, 3)} ${d.getDate()} ${MONTH[d.getMonth()]!.slice(0, 3)}`;
}

export function isoDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse YYYY-MM-DD as a local date. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

/** The date lane on the desk: "Mon 16" when near, "Jan 15" when further off. */
export function dueLane(day: string, now: number): string {
  const d = parseDay(day);
  const days = Math.round((d.getTime() - parseDay(isoDay(now)).getTime()) / DAY);
  if (days === 0) return 'Today';
  if (days < 0) return 'Late';
  if (days <= 20) return `${WEEKDAY[d.getDay()]!.slice(0, 3)} ${d.getDate()}`;
  return `${MONTH[d.getMonth()]!.slice(0, 3)} ${d.getDate()}`;
}

/**
 * How long until a limit starts again, counting down: days to the nearest day while more than
 * 24 hours are left ("4 days"), then hours ("17 hours"), then minutes in the last hour.
 */
export function resetIn(at: number, now: number): string {
  const mins = Math.ceil((at - now) / 60_000);
  if (mins <= 0) return 'a moment';
  if (mins <= 60) return plural(mins, 'minute');
  if (mins <= 24 * 60) return plural(Math.ceil(mins / 60), 'hour');
  return plural(Math.round(mins / (24 * 60)), 'day');
}

/** A count of tokens in thousands: "131K", "1.2M". */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n < 1000) return n <= 0 ? '0' : 'under 1K';
  return `${Math.round(n / 1000)}K`;
}

/** An appointment's time of day, kept as "14:00", shown as "2:00 pm". */
export function timeOfDay(time: string | null | undefined): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

/** "Tuesday 24 November" */
export function dayHeading(day: string): string {
  const d = parseDay(day);
  return `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
}

export function daysAway(day: string, now: number): string {
  const days = Math.round((parseDay(day).getTime() - parseDay(isoDay(now)).getTime()) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${-days} days ago`;
  return `In ${days} days`;
}

/** Compact duration for lanes: "8 sec", "3 min", "1 hr 4 min". */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} hr ${rm} min` : `${h} hr`;
}

/** Duration in words for sentences: "6 minutes", "40 seconds". */
export function durWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h} hour${h === 1 ? '' : 's'}${rm ? ` ${rm} min` : ''}`;
}

/** When something happened, for lanes: a clock time today, else a short date. */
export function when(ms: number, now: number): string {
  return isoDay(ms) === isoDay(now) ? clock(ms) : shortDate(ms);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function greeting(ms: number): string {
  const h = new Date(ms).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
