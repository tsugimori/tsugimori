import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cronCadence, intervalCadence } from '../src/cadence.ts';

test('humanizes common cron patterns in English and Traditional Chinese', () => {
  for (const [expression, english, chinese] of [
    ['* * * * *', 'every minute', '每分鐘'],
    ['*/15 * * * *', 'every 15 minutes', '每 15 分鐘'],
    ['*/7 * * * *', 'every 7 minutes within each hour', '每小時內每 7 分鐘'],
    ['5 * * * *', 'hourly at :05', '每小時第 05 分鐘'],
    [
      '0 12-23 * * *',
      'hourly 12:00–23:00 daily',
      '每天 12:00–23:00 每小時整點',
    ],
    ['30 8 * * *', 'at 08:30 daily', '每天 08:30'],
    ['30 8 * * 1-5', 'at 08:30 on weekdays', '平日 08:30'],
    ['30 8 * * 6,7', 'at 08:30 on weekends', '週末 08:30'],
    [
      '30 8 * * 1,3,5',
      'at 08:30 on Monday, Wednesday, and Friday',
      '週一、週三、週五 08:30',
    ],
    ['0 9 15 * *', 'monthly on day 15 at 09:00', '每月 15 日 09:00'],
    ['0 9 15 * 1', 'cron 0 9 15 * 1', 'cron 表達式 0 9 15 * 1'],
  ] as const) {
    assert.equal(cronCadence(expression, 'en'), english, expression);
    assert.equal(cronCadence(expression, 'zh-TW'), chinese, expression);
  }
});

test('chooses units for fixed intervals in both locales', () => {
  for (const [minutes, english, chinese] of [
    [45, 'every 45 minutes', '每 45 分鐘'],
    [60, 'hourly', '每小時'],
    [120, 'every 2 hours', '每 2 小時'],
    [1_440, 'daily', '每天'],
  ] as const) {
    assert.equal(intervalCadence(minutes, 'en'), english);
    assert.equal(intervalCadence(minutes, 'zh-TW'), chinese);
  }
});
