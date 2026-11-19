/**
 * Photos taken in the app. A phone's camera hands every picture over as "image.jpg", so each one
 * is given a name that says when it was taken before it goes to the office.
 */

/** The server's limit for one file. */
export const MAX_PHOTO = 25 * 1024 * 1024;

/** A phone or a tablet: somewhere a camera button opens a camera. */
export const hasTouch = (): boolean => window.matchMedia('(pointer: coarse)').matches;

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp', 'image/gif': 'gif' };

/** "Photo 2026-11-15 15.42.07.jpg", in the device's own time. */
export function photoName(file: { name: string; type: string }, at = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const fromName = /\.([A-Za-z0-9]{2,5})$/.exec(file.name)?.[1]?.toLowerCase();
  const ext = EXT[file.type] ?? fromName ?? 'jpg';
  return `Photo ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${two(at.getSeconds())}.${ext}`;
}

/**
 * Files chosen from the phone: a photo from the library can arrive as "image.jpg" too, and only
 * those are renamed. A file with a name of its own keeps it.
 */
export function namedFiles(chosen: FileList | null): File[] {
  if (!chosen) return [];
  const at = new Date();
  return [...chosen].map((f, i) => (/^image\.[a-z0-9]{2,5}$/i.test(f.name) ? new File([f], photoName(f, new Date(at.getTime() + i * 1000)), { type: f.type, lastModified: f.lastModified }) : f));
}

/** The pictures from a camera input, each under its own dated name. */
export function namedPhotos(chosen: FileList | null): File[] {
  if (!chosen) return [];
  const at = new Date();
  return [...chosen].map((f, i) => new File([f], photoName(f, new Date(at.getTime() + i * 1000)), { type: f.type, lastModified: f.lastModified }));
}
