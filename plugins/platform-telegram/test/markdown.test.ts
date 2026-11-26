import { renderMarkdown } from '@tsugimori/plugin-sdk';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { telegramMessageParts } from '../src/message-text.ts';

function parts(text: string) {
  return telegramMessageParts({ chatId: '1', format: 'markdown', text });
}

const examples = [
  [
    '**bold** __strong__ *italic* _emphasis_ ~~strike~~',
    'bold strong italic emphasis strike',
    [
      { type: 'bold', offset: 0, length: 4 },
      { type: 'bold', offset: 5, length: 6 },
      { type: 'italic', offset: 12, length: 6 },
      { type: 'italic', offset: 19, length: 8 },
      { type: 'strikethrough', offset: 28, length: 6 },
    ],
  ],
  [
    '**bold *and italic*** ',
    'bold and italic ',
    [
      { type: 'bold', offset: 0, length: 15 },
      { type: 'italic', offset: 5, length: 10 },
    ],
  ],
  [
    '**a `**raw**` b**',
    'a **raw** b',
    [
      { type: 'bold', offset: 0, length: 2 },
      { type: 'code', offset: 2, length: 7 },
      { type: 'bold', offset: 9, length: 2 },
    ],
  ],
  ['``a ` b``', 'a ` b', [{ type: 'code', offset: 0, length: 5 }]],
  [
    '```js\nlet x = "**";\n```\nAfter',
    'let x = "**";\nAfter',
    [{ type: 'pre', offset: 0, length: 13, language: 'js' }],
  ],
  [
    '~~~sh\nls\n~~~~',
    'ls',
    [{ type: 'pre', offset: 0, length: 2, language: 'sh' }],
  ],
  [
    '☀️台灣😀 **70%** [氣象🛰️](https://example.test/a_(b))',
    '☀️台灣😀 70% 氣象🛰️',
    [
      { type: 'bold', offset: 7, length: 3 },
      {
        type: 'text_link',
        offset: 11,
        length: 5,
        url: 'https://example.test/a_(b)',
      },
    ],
  ],
  [
    'https://example.test/a_b_c ~~https://example.test/a_b~~',
    'https://example.test/a_b_c https://example.test/a_b',
    [{ type: 'strikethrough', offset: 27, length: 24 }],
  ],
  [
    '## Heading ##\n- **one**\n* two\n1. three\n2) four',
    'Heading\n• one\n• two\n1. three\n2) four',
    [
      { type: 'bold', offset: 0, length: 7 },
      { type: 'bold', offset: 10, length: 3 },
    ],
  ],
  [
    '> **晴天**\n> ☀️ 明天\nOutside',
    '晴天\n☀️ 明天\nOutside',
    [
      { type: 'blockquote', offset: 0, length: 8 },
      { type: 'bold', offset: 0, length: 2 },
    ],
  ],
] as const;

for (const [markdown, text, entities] of examples) {
  test('renders ' + JSON.stringify(markdown), () => {
    assert.deepEqual(parts(markdown), [{ text, entities }]);
  });
}

test('keeps unsupported or unmatched markup literal and handles escaped punctuation', () => {
  const literal = [
    'A snake_case name, **mismatched*, * open, ~~unfinished',
    '[bad](https://example.test ![**alt**](https://example.test/a.webp)',
    '[local](relative/path) and <https://example.test>',
    '---',
    '```ts\n*unclosed fence*',
  ].join('\n');
  assert.deepEqual(parts(literal), [{ text: literal, entities: undefined }]);
  assert.deepEqual(parts('\\*escaped\\* and `unclosed'), [
    { text: '*escaped* and `unclosed', entities: undefined },
  ]);
});

test('leaves asterisks in bare URLs and closes surrounding emphasis', () => {
  const url = 'https://example.test/a*b*';
  assert.deepEqual(parts(url), [{ text: url, entities: undefined }]);
  assert.deepEqual(parts('**https://example.test/a*b**.'), [
    {
      text: 'https://example.test/a*b.',
      entities: [{ type: 'bold', offset: 0, length: 24 }],
    },
  ]);
});

test('renders fences inside quotes and list items without interpreting their contents', () => {
  const code = '[code](tg://user?id=83)';
  assert.deepEqual(parts('> ```ts\n> ' + code + '\n> ```'), [
    {
      text: code,
      entities: [
        { type: 'blockquote', offset: 0, length: code.length },
        { type: 'pre', offset: 0, length: code.length, language: 'ts' },
      ],
    },
  ]);
  assert.deepEqual(parts('1. ```ts\n   ' + code + '\n   ```'), [
    {
      text: '1.\n' + code,
      entities: [
        { type: 'pre', offset: 3, length: code.length, language: 'ts' },
      ],
    },
  ]);
});

test('combines Markdown with native mentions and leaves code contents literal', () => {
  const literal = '[code](tg://user?id=83)';
  const text =
    '😀 **請[舊名](tg://user?id=79)喝水**，*小林* `' +
    literal +
    '`\n```\n' +
    literal +
    '\n```';
  const rendered =
    '😀 請 @new_name 喝水，小林 ' + literal + '\n' + literal + '\n\nuser 81';
  assert.deepEqual(
    telegramMessageParts(
      {
        chatId: '1',
        format: 'markdown',
        text,
        entities: [
          {
            type: 'mention',
            userId: '80',
            offset: text.indexOf('小林'),
            length: 2,
          },
          {
            type: 'mention',
            userId: '83',
            offset: text.indexOf('code'),
            length: 4,
          },
        ],
        mentions: ['79', '81'],
      },
      (id) =>
        id === '79' ? { display: null, username: 'new_name' } : undefined,
    ),
    [
      {
        text: rendered,
        entities: [
          { type: 'bold', offset: 3, length: '請 @new_name 喝水'.length },
          {
            type: 'text_mention',
            user: { id: 80 },
            offset: rendered.indexOf('小林'),
            length: 2,
          },
          { type: 'italic', offset: rendered.indexOf('小林'), length: 2 },
          {
            type: 'code',
            offset: rendered.indexOf(literal),
            length: literal.length,
          },
          {
            type: 'pre',
            offset: rendered.lastIndexOf(literal),
            length: literal.length,
          },
          {
            type: 'text_mention',
            user: { id: 81 },
            offset: rendered.indexOf('user 81'),
            length: 7,
          },
        ],
      },
    ],
  );
});

test('checks for text mentions exposed by Markdown after schedule authorization', () => {
  const scheduled = {
    chatId: '1',
    format: 'markdown',
    allowTextMentions: false,
  } as const;
  for (const text of [
    '@[someone](https://example.test)',
    '**t.me**/someone',
    '[person](tg://user?id=42)',
  ]) {
    assert.throws(
      () => telegramMessageParts({ ...scheduled, text }),
      /unapproved mention/,
    );
  }
  assert.deepEqual(
    telegramMessageParts({ ...scheduled, text: '**news**', mentions: ['42'] }),
    [
      {
        text: 'news\n\nuser 42',
        entities: [
          { type: 'bold', offset: 0, length: 4 },
          { type: 'text_mention', user: { id: 42 }, offset: 6, length: 7 },
        ],
      },
    ],
  );
});

test('leaves fixed reminder Markdown and explicit mention ranges in place', () => {
  const text = '# 考試\n- **記得** [網址](https://example.test) 請小林';
  assert.deepEqual(
    telegramMessageParts({
      chatId: '1',
      parseTextMentions: false,
      text,
      entities: [
        {
          type: 'mention',
          userId: '42',
          offset: text.indexOf('小林'),
          length: 2,
        },
      ],
    }),
    [
      {
        text,
        entities: [
          {
            type: 'text_mention',
            user: { id: 42 },
            offset: text.indexOf('小林'),
            length: 2,
          },
        ],
      },
    ],
  );
});

test('moves an entire nested formatted span to the next chunk and rebases entities', () => {
  const padding = '界'.repeat(4093);
  assert.deepEqual(parts(padding + ' **甲\n*[乙😀](https://example.test)***'), [
    { text: padding + ' ', entities: undefined },
    {
      text: '甲\n乙😀',
      entities: [
        { type: 'bold', offset: 0, length: 5 },
        {
          type: 'text_link',
          offset: 2,
          length: 3,
          url: 'https://example.test',
        },
        { type: 'italic', offset: 2, length: 3 },
      ],
    },
  ]);
});

test('keeps fitting pre spans whole and splits oversized pre with its language and valid UTF-16 boundaries', () => {
  const padding = '字'.repeat(4094);
  assert.deepEqual(parts(padding + '\n```ts\nfirst\nsecond\n```'), [
    { text: padding + '\n', entities: undefined },
    {
      text: 'first\nsecond',
      entities: [{ type: 'pre', offset: 0, length: 12, language: 'ts' }],
    },
  ]);
  const line = '字'.repeat(4095);
  assert.deepEqual(parts('```ts\n' + line + '😀\nmore\n```\n**after**'), [
    {
      text: line,
      entities: [{ type: 'pre', offset: 0, length: 4095, language: 'ts' }],
    },
    {
      text: '😀\nmore\nafter',
      entities: [
        { type: 'pre', offset: 0, length: 7, language: 'ts' },
        { type: 'bold', offset: 8, length: 5 },
      ],
    },
  ]);
});

test('uses plain text for a non-pre entity that cannot fit in a single chunk', () => {
  const text = '字'.repeat(4100);
  assert.deepEqual(parts('**' + text + '**'), [
    { text: text.slice(0, 4096), entities: undefined },
    { text: text.slice(4096), entities: undefined },
  ]);
});

test('keeps Markdown tables preformatted by default in the SDK', () => {
  const text = '| Time | Rain |\n| --- | ---: |\n| Morning | **70%** |';
  assert.deepEqual(renderMarkdown(text, new Map(), true), {
    text,
    entities: [{ type: 'pre', offset: 0, length: text.length }],
  });
});

test('renders bullet groups with cell formatting, mentions, and empty cells', () => {
  const source = [
    '| Item | *Cost* | Owner | Notes |',
    '| --- | ---: | --- | --- |',
    '| **Plan** | `$400-600K` | [Alex](tg://user?id=79) | |',
    '| Next | | | [more](https://example.test) |',
    '| Last | | | A \\| B |',
  ].join('\n');
  const text =
    'Plan\n• Cost: $400-600K\n• Owner: Alex\n\nNext\n• Notes: more\n\nLast\n• Notes: A | B';
  assert.deepEqual(
    renderMarkdown(source, new Map(), true, true, { tables: 'bullets' }),
    {
      text,
      entities: [
        { type: 'bold', offset: 0, length: 4 },
        { type: 'italic', offset: text.indexOf('Cost'), length: 4 },
        { type: 'code', offset: text.indexOf('$'), length: 9 },
        {
          type: 'mention',
          offset: text.indexOf('Alex'),
          length: 4,
          userId: '79',
        },
        { type: 'bold', offset: text.indexOf('Next'), length: 4 },
        {
          type: 'text_link',
          offset: text.indexOf('more'),
          length: 4,
          url: 'https://example.test',
        },
        { type: 'bold', offset: text.indexOf('Last'), length: 4 },
      ],
    },
  );
});

test('renders single-column tables next to lists, quotes, and fenced code', () => {
  const source = [
    '- Before',
    '| Item |',
    '| --- |',
    '| **One** |',
    '| |',
    '| `A|B` |',
    '> Quoted | text',
    '```ts',
    '| a | b |',
    '| --- | --- |',
    '```',
    'After',
  ].join('\n');
  const code = '| a | b |\n| --- | --- |';
  const text = '• Before\n• One\n• A|B\nQuoted | text\n' + code + '\nAfter';
  assert.deepEqual(
    renderMarkdown(source, new Map(), true, true, { tables: 'bullets' }),
    {
      text,
      entities: [
        { type: 'bold', offset: text.indexOf('One'), length: 3 },
        { type: 'code', offset: text.indexOf('A|B'), length: 3 },
        { type: 'blockquote', offset: text.indexOf('Quoted'), length: 13 },
        {
          type: 'pre',
          offset: text.indexOf(code),
          length: code.length,
          language: 'ts',
        },
      ],
    },
  );
});
