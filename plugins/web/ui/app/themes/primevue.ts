import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

const shades = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const primary = {
  color: 'var(--console-primary-color)',
  contrastColor: 'var(--console-primary-contrast)',
  hoverColor: 'var(--console-primary-hover)',
  activeColor: 'var(--console-primary-active)',
};
const surface = Object.fromEntries(
  [0, ...shades].map((shade) => [shade, `var(--console-surface-${shade})`]),
);

export default {
  preset: definePreset(Aura, {
    semantic: {
      primary: Object.fromEntries(
        shades.map((shade) => [shade, `var(--console-primary-${shade})`]),
      ),
      colorScheme: {
        light: {
          primary,
          surface,
          text: {
            color: '{surface.800}',
            hoverColor: '{surface.900}',
            mutedColor: '{surface.700}',
            hoverMutedColor: '{surface.800}',
          },
        },
        dark: {
          primary,
          surface,
          text: {
            color: '{surface.0}',
            hoverColor: '{surface.50}',
            mutedColor: '{surface.200}',
            hoverMutedColor: '{surface.100}',
          },
        },
      },
    },
  }),
  options: {
    prefix: 'p',
    darkModeSelector: '.dark',
    cssLayer: {
      name: 'primevue',
      order: 'theme, base, primevue, components, utilities',
    },
  },
};
