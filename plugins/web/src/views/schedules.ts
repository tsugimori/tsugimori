import type { AdminSchedules } from '@tsugimori/plugin-sdk';

import type { ViewContext } from '../format.ts';

import { escapeHtml, time } from '../format.ts';
import { i18n } from '../i18n.ts';
import { badge, empty, linkedChat } from './shared.ts';

export function schedulesView({ schedules }: AdminSchedules, ctx: ViewContext) {
  const m = i18n(ctx.locale);
  return `<div class="section-head"><h1>${m.schedules}</h1></div><div class="schedule-list">${
    schedules.length
      ? schedules
          .map(
            (schedule) => `<article class="card approval-row">
<div><h2>${escapeHtml(schedule.title.slice(0, 180))}</h2><p>${linkedChat(schedule, schedule.chat)}</p></div>
<p class="requested meta">${m.nextRun} · ${time(schedule.nextDueAt, ctx, 'future')}</p>
<p class="decision">${badge(schedule.status, ctx.locale)}</p></article>`,
          )
          .join('\n')
      : empty(m.noSchedules)
  }</div>`;
}
