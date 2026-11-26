import type { Locale } from './i18n.ts';

import { escapeHtml, number } from './format.ts';
import { i18n } from './i18n.ts';
import { css } from './style.ts';

export type Section = 'overview' | 'chats' | 'approvals' | 'schedules';

interface Page {
  active?: Section;
  body: string;
  locale: Locale;
  name?: string;
  pending?: number;
  schedules?: boolean;
  title: string;
}

export function page({
  title,
  active,
  body,
  locale,
  name,
  pending = 0,
  schedules,
}: Page) {
  const m = i18n(locale);
  const nav: [Section, string][] = [
    ['overview', '/'],
    ['chats', '/chats'],
    ['approvals', '/approvals'],
  ];
  if (schedules) nav.push(['schedules', '/schedules']);
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · tsugimori</title><style>${css}</style></head>
<body><header class="top"><div class="wrap">
<div class="brand"><span class="dot" aria-hidden="true"></span><strong>tsugimori</strong>${name ? `<span class="meta ellipsis">${escapeHtml(name)}</span>` : ''}</div>
<nav aria-label="${m.nav}">${nav
    .map(
      ([key, href]) =>
        `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${m[key]}${key === 'approvals' && pending > 0 ? ` <span class="pill">${number(pending)}</span>` : ''}</a>`,
    )
    .join('')}</nav>
</div></header><main class="wrap">${body}</main></body></html>`;
}
