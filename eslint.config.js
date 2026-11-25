import perfectionist from 'eslint-plugin-perfectionist';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/drizzle/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      'perfectionist/sort-imports': 'error',
      'perfectionist/sort-interfaces': 'error',
      'perfectionist/sort-named-exports': 'error',
      'perfectionist/sort-named-imports': 'error',
      'perfectionist/sort-object-types': 'error',
    },
    plugins: { perfectionist },
  },
  {
    files: ['plugins/**/*.{js,ts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^@tsugimori/(?!plugin-sdk(?:$|/))|(?:^|/)packages/',
              message:
                'Official plugins may only import Tsugimori contracts from plugin-sdk.',
            },
          ],
        },
      ],
    },
  },
];
