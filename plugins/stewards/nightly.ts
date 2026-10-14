// When the nightly pass runs. The project file names a local time and a time
// zone; bb's schedules run on the server's clock, so a schedule fires every
// few minutes and asks this whether a project's night has come and not yet
// been passed. Pure: the clock is an argument.

const minutesOf = (clock: string): number => {
  const [h, m] = clock.split(":").map(Number);
  return h! * 60 + m!;
};

/** The calendar date and minute of the day at `now` in a time zone. */
export function localParts(now: number, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/**
 * The night `now` falls in, named by the date its window opened, or null
 * outside the window. A window that crosses midnight (23:00 to 02:00) belongs
 * to the evening it started.
 */
export function nightOf(now: number, nightly: { at: string; until: string; timezone: string }): string | null {
  const at = minutesOf(nightly.at);
  const until = minutesOf(nightly.until);
  const here = localParts(now, nightly.timezone);
  if (at < until) return here.minutes >= at && here.minutes < until ? here.date : null;
  if (here.minutes >= at) return here.date;
  if (here.minutes < until) return localParts(now - 86_400_000, nightly.timezone).date;
  return null;
}

/** Whether a pass is due: inside tonight's window and tonight not yet passed. */
export function nightlyDue(now: number, nightly: { at: string; until: string; timezone: string }, lastNight: string | null): string | null {
  const night = nightOf(now, nightly);
  return night !== null && night !== lastNight ? night : null;
}

/** Whether there is still time tonight to start another turn. */
export const stillNight = (now: number, nightly: { at: string; until: string; timezone: string }, night: string): boolean => nightOf(now, nightly) === night;
