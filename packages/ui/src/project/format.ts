import { FLICKS_PER_SECOND } from '@cgv/engine-client';

/** "1:05.5" for 65.5 seconds of flicks; hours appear when needed. */
export function formatTime(flicks: number): string {
  const tenths = Math.round((flicks / FLICKS_PER_SECOND) * 10);
  const seconds = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const clock = h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  return `${clock}.${fraction}`;
}

/** "Today 14:03", or a date for older times. */
export function formatWhen(ms: number | null | undefined): string {
  if (!ms) return '';
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? `Today ${time}`
    : `${date.toLocaleDateString()} ${time}`;
}

export function formatRate({ num, den }: { num: number; den: number }): string {
  const value = num / den;
  return den === 1 ? String(num) : String(Number(value.toFixed(3)));
}
