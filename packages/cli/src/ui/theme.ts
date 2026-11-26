/** The colours of the UI; `undefined` means the terminal's default. */
export interface Theme {
  brand?: string;
  user?: string;
  agent?: string;
  tool?: string;
  success?: string;
  warning?: string;
  error?: string;
  info?: string;
}

/**
 * Returns the UI colours. Only the 16 named ANSI colours are used, so the
 * terminal palette decides the shade. With `NO_COLOR` set, every colour is
 * dropped but bold, dim and inverse stay, so the cursor remains visible.
 * @param env Environment to read `NO_COLOR` from.
 */
export function makeTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  if (env.NO_COLOR) return {};
  return {
    brand: 'magenta',
    user: 'cyan',
    agent: 'magenta',
    tool: 'blue',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    info: 'cyan',
  };
}

/** The colours for this process. */
export const theme: Theme = makeTheme();

/**
 * Glyphs used across the UI. All have East Asian width "neutral", so boxes
 * stay aligned in terminals that draw ambiguous-width characters wide.
 */
export const glyphs = {
  brand: '✦',
  prompt: '❯',
  tool: '↳',
  success: '✓',
  error: '✗',
  warning: '!',
  info: '-',
  arrow: '➜',
  mask: '*',
} as const;
