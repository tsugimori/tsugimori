export const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;
const searchDays = 8 * 366;

export function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^(\*|\d{1,2})(?:-(\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw new Error('Invalid cron field');
    const [, first, last, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    const from = first === '*' ? min : Number(first);
    const to =
      last !== undefined
        ? Number(last)
        : first === '*' || stepText
          ? max
          : from;
    if (
      from < min ||
      to > max ||
      from > to ||
      step === 0 ||
      (first === '*' && last)
    )
      throw new Error('Invalid cron field range');
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export class Cron {
  readonly #format;
  readonly #minutes;
  readonly #hours;
  readonly #days;
  readonly #months;
  readonly #weekdays;
  readonly #anyDay;
  readonly #anyWeekday;
  readonly #from;

  constructor(expression: string, timezone: string, from = -Infinity) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) throw new Error('Cron requires five fields');
    const [minutes, hours, days, months, weekdays] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    this.#minutes = parseField(minutes, 0, 59);
    this.#hours = parseField(hours, 0, 23);
    this.#days = parseField(days, 1, 31);
    this.#months = parseField(months, 1, 12);
    this.#weekdays = parseField(weekdays, 0, 7).map((day) => day % 7);
    this.#anyDay = days.startsWith('*');
    this.#anyWeekday = weekdays.startsWith('*');
    this.#from = from;
    this.#format = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
  }

  next(after: number) {
    after = Math.max(after, this.#from - 1);
    return this.#find(after, 1, (value) => value > after);
  }

  latest(through: number) {
    if (through < this.#from) return undefined;
    const due = this.#find(through, -1, (value) => value <= through);
    return due !== undefined && due >= this.#from ? due : undefined;
  }

  tooFrequent(from: number, threshold: number, until = Infinity) {
    if (threshold <= 1) return false;
    from = Math.max(from, this.#from);
    const span = threshold * minuteMs;
    const day = Math.floor(this.#local(from) / dayMs) * dayMs;
    let previous: number | undefined;
    // A year covers the offset changes of ordinary seasonal clock rules.
    for (let n = 0; n <= 366; n++) {
      for (const value of this.#occurrences(day + n * dayMs)) {
        if (value < from) continue;
        if (value > until) return false;
        if (previous !== undefined && value - previous < span) return true;
        previous = value;
      }
    }
    return false;
  }

  #find(at: number, direction: 1 | -1, accept: (value: number) => boolean) {
    const day = Math.floor(this.#local(at) / dayMs) * dayMs;
    for (let n = 0; n <= searchDays; n++) {
      const values = this.#occurrences(day + n * direction * dayMs);
      const result = (direction === -1 ? values.reverse() : values).find(
        accept,
      );
      if (result !== undefined) return result;
    }
    return undefined;
  }

  #local(at: number) {
    const parts = Object.fromEntries(
      this.#format
        .formatToParts(at)
        .map(({ type, value }) => [type, Number(value)]),
    );
    return Date.UTC(
      parts.year!,
      parts.month! - 1,
      parts.day!,
      parts.hour!,
      parts.minute!,
    );
  }

  #occurrences(day: number) {
    const date = new Date(day);
    const dayMatches = this.#days.includes(date.getUTCDate());
    const weekdayMatches = this.#weekdays.includes(date.getUTCDay());
    if (
      !this.#months.includes(date.getUTCMonth() + 1) ||
      !(this.#anyDay || this.#anyWeekday
        ? dayMatches && weekdayMatches
        : dayMatches || weekdayMatches)
    )
      return [];

    const offsets = new Set<number>();
    for (const hours of [-24, -12, 0, 12, 24, 36, 48]) {
      const sample = day + hours * 60 * minuteMs;
      offsets.add(this.#local(sample) - sample);
    }
    const values: number[] = [];
    for (const hour of this.#hours) {
      for (const minute of this.#minutes) {
        const local = day + (hour * 60 + minute) * minuteMs;
        for (const offset of offsets) {
          const instant = local - offset;
          if (offsets.size === 1 || this.#local(instant) === local)
            values.push(instant);
        }
      }
    }
    return values.sort((a, b) => a - b);
  }
}
