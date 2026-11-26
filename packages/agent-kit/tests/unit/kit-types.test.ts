import type { z } from 'genkit';
import { expectTypeOf, test } from 'vitest';
import type { KitToolFn } from '../../src/index.js';

type ToolContext = Parameters<
  KitToolFn<z.ZodString, z.ZodString>
>[1]['context'];

test('a kit tool sees the caller uid as a string', () => {
  expectTypeOf<ToolContext['auth']['uid']>().toEqualTypeOf<string>();
});
