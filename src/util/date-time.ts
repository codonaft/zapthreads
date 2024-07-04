import { Eid } from "./models.ts";

export const MIN_IN_SECS = 60;
export const HOUR_IN_SECS = 60 * MIN_IN_SECS;
export const SIX_HOURS_IN_SECS = 6 * HOUR_IN_SECS;
export const DAY_IN_SECS = 24 * HOUR_IN_SECS;
export const WEEK_IN_SECS = 7 * DAY_IN_SECS;

export const currentTime = () => Math.round(Date.now() / 1000);

export const sortByDate = <T extends { id: Eid; ts?: number; }>(arr: T[]) => arr.sort((a, b) => {
  const aTs = a.ts || 0;
  const bTs = b.ts || 0;
  return aTs !== bTs ? bTs - aTs : a.id.localeCompare(b.id);
});

export const timeAgo = (timestamp: number): string => {
  const now = new Date();
  const secondsPast = Math.floor((now.getTime() - timestamp) / 1000);

  if (secondsPast < 60) {
    return 'now';
  }
  if (secondsPast < 3600) {
    const m = Math.floor(secondsPast / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (secondsPast <= 86400) {
    const h = Math.floor(secondsPast / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  // 604800ms = 1 week
  if (secondsPast <= 604800) {
    const d = Math.floor(secondsPast / 86400);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  if (secondsPast > 604800) {
    const date: Date = new Date(timestamp);
    const day = date.toLocaleDateString('en-us', { day: "numeric", month: "long" });
    const year = date.getFullYear() === now.getFullYear() ? '' : ' ' + date.getFullYear();
    return 'on ' + day + year;
  }
  return '';
};
