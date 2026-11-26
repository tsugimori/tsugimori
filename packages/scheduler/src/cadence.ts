import { parseField } from './cron.ts';

export type ScheduleLocale = 'en' | 'zh-TW';

export function intervalCadence(minutes: number, locale: ScheduleLocale) {
  const zh = locale === 'zh-TW';
  if (minutes === 1_440) return zh ? '每天' : 'daily';
  if (minutes === 60) return zh ? '每小時' : 'hourly';
  if (minutes % 60 === 0)
    return zh ? `每 ${minutes / 60} 小時` : `every ${minutes / 60} hours`;
  if (minutes === 1) return zh ? '每分鐘' : 'every minute';
  return zh ? `每 ${minutes} 分鐘` : `every ${minutes} minutes`;
}

const weekdays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const weekdaysZh = ['日', '一', '二', '三', '四', '五', '六'];

function cronDays(field: string, locale: ScheduleLocale) {
  if (field === '*') return '';
  if (!/^[0-7](?:-[0-7])?(?:,[0-7](?:-[0-7])?)*$/.test(field)) return undefined;
  const days = [
    ...new Set(parseField(field, 0, 7).map((day) => day % 7)),
  ].sort();
  const zh = locale === 'zh-TW';
  if (days.length === 7) return '';
  if (days.join() === '1,2,3,4,5') return zh ? '平日' : 'on weekdays';
  if (days.join() === '0,6') return zh ? '週末' : 'on weekends';
  return zh
    ? days.map((day) => `週${weekdaysZh[day]}`).join('、')
    : `on ${new Intl.ListFormat('en').format(days.map((day) => weekdays[day]!))}`;
}

const twoDigits = (value: string) => value.padStart(2, '0');

export function cronCadence(expression: string, locale: ScheduleLocale) {
  const zh = locale === 'zh-TW';
  const fallback = `${zh ? 'cron 表達式' : 'cron'} ${expression}`;
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [minute, hour, day, month, weekday] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (month !== '*') return fallback;
  const minuteStep =
    minute === '*' ? 1 : Number(/^\*\/(\d{1,2})$/.exec(minute)?.[1]);
  const fixedMinute = /^[0-5]?\d$/.test(minute) ? twoDigits(minute) : undefined;
  const fixedHour = /^(?:[01]?\d|2[0-3])$/.test(hour);
  if (day !== '*') {
    const date = Number(day);
    if (
      weekday !== '*' ||
      !/^\d{1,2}$/.test(day) ||
      date < 1 ||
      date > 31 ||
      !fixedMinute ||
      !fixedHour
    )
      return fallback;
    const time = `${twoDigits(hour)}:${fixedMinute}`;
    return zh ? `每月 ${date} 日 ${time}` : `monthly on day ${date} at ${time}`;
  }

  const days = cronDays(weekday, locale);
  if (days === undefined) return fallback;
  const withDays = (cadence: string) =>
    days ? (zh ? days + cadence : `${cadence} ${days}`) : cadence;
  if (hour === '*') {
    if (minuteStep > 0 && minuteStep < 60) {
      const cadence = intervalCadence(minuteStep, locale);
      const resets = 60 % minuteStep !== 0;
      return withDays(
        resets
          ? zh
            ? `每小時內${cadence}`
            : `${cadence} within each hour`
          : cadence,
      );
    }
    const minuteOfHour = fixedMinute ?? (minuteStep >= 60 ? '00' : undefined);
    if (minuteOfHour)
      return withDays(
        zh
          ? minuteOfHour === '00'
            ? '每小時整點'
            : `每小時第 ${minuteOfHour} 分鐘`
          : `hourly at :${minuteOfHour}`,
      );
  }
  if (fixedMinute) {
    if (fixedHour) {
      const time = `${twoDigits(hour)}:${fixedMinute}`;
      return zh ? `${days || '每天'} ${time}` : `at ${time} ${days || 'daily'}`;
    }
    const range = /^(\d{1,2})-(\d{1,2})$/.exec(hour);
    if (
      range &&
      Number(range[1]) < Number(range[2]) &&
      Number(range[2]) <= 23
    ) {
      const times = `${twoDigits(range[1]!)}:${fixedMinute}–${twoDigits(range[2]!)}:${fixedMinute}`;
      return zh
        ? `${days || '每天'} ${times} 每小時${fixedMinute === '00' ? '整點' : `第 ${fixedMinute} 分鐘`}`
        : `hourly ${times} ${days || 'daily'}`;
    }
  }
  return fallback;
}
