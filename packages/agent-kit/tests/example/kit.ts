import { genkit, z } from 'genkit/beta';
import { createKitGenkit } from '../../src/lib.js';

/** The Genkit instance that the example's tools register on. */
export const instance = genkit({});

/** The names of the tools that the example registered. */
export const toolNames = new Set<string>();

/** Stands in for the kit's `ai` export, without the kit's functions. */
export const ai = createKitGenkit(instance, toolNames);

export { z };
