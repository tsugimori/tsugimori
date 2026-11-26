import { readFile, writeFile } from 'node:fs/promises';

import theme from '../../app/themes/primevue.ts';
import { generatePrimeVueStyles } from './primevue.ts';

const outputPath = new URL(
  '../../app/assets/css/generated.css',
  import.meta.url,
);
const { css, styleIds } = await generatePrimeVueStyles(theme);
const output = `@layer ${theme.options.cssLayer.order};\n\n${css}\n`;
const previous = await readFile(outputPath, 'utf8').catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  },
);
if (output !== previous) await writeFile(outputPath, output);
console.log(
  `${output === previous ? 'CSS is current' : 'Generated CSS'}: ${styleIds.length} PrimeVue blocks, ${Buffer.byteLength(output)} bytes`,
);
