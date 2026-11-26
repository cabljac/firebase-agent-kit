import type { z } from 'genkit';
import type { GenkitBeta } from 'genkit/beta';
import { expectTypeOf, test } from 'vitest';
import type { KitGenkit, KitToolFn } from '../../src/index.js';

type ToolContext = Parameters<
  KitToolFn<z.ZodString, z.ZodString>
>[1]['context'];

type DefineToolContext = Parameters<
  Parameters<KitGenkit['defineTool']>[1]
>[1]['context'];

test('a kit tool sees the caller uid as a string', () => {
  expectTypeOf<ToolContext['auth']['uid']>().toEqualTypeOf<string>();
});

test('ai.defineTool gives the tool function the caller uid as a string', () => {
  expectTypeOf<DefineToolContext['auth']['uid']>().toEqualTypeOf<string>();
});

test('ai keeps the Genkit signatures of the members it does not override', () => {
  expectTypeOf<KitGenkit['defineModel']>().toEqualTypeOf<
    GenkitBeta['defineModel']
  >();
  expectTypeOf<KitGenkit['defineFlow']>().toEqualTypeOf<
    GenkitBeta['defineFlow']
  >();
});
