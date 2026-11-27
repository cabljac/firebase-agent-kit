import { randomInt } from 'node:crypto';
import { ai, z } from '@cabljac/firebase-agent-kit';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const MAX_INVENTORY = 20;
const MAX_STARTING_ITEMS = 3;
const MAX_ITEMS_PER_UPDATE = 5;
const HP_CHANGE = { min: -50, max: 50 };
const COINS_CHANGE = { min: -1000, max: 1000 };
const DICE = { count: { min: 1, max: 10 }, sides: { min: 2, max: 100 } };
const MODIFIER = { min: -20, max: 20 };
const DIFFICULTY = { min: 5, max: 25 };

const Name = z.string().min(1).max(40);

// Genkit turns a schema used twice in one tool into a $ref, which Gemini rejects.
const item = () =>
  Name.describe('One item, for example Rope or Plasma cutter.');

const range = () => z.object({ min: z.number(), max: z.number() });

const Character = z.object({
  name: z.string(),
  role: z.string(),
  hp: z.number(),
  maxHp: z.number(),
  coins: z.number(),
  inventory: z.array(z.string()),
});
type Character = z.infer<typeof Character>;

function world(): string {
  // firebase-tools sets this for each kit instance, in deploys and the emulator.
  const id = process.env.FIREBASE_KIT_INSTANCE_ID;
  if (!id || !/^[a-z0-9_-]{1,40}$/.test(id)) {
    throw new Error('FIREBASE_KIT_INSTANCE_ID is not set.');
  }
  return id;
}

function characterOf(uid: string) {
  return getFirestore()
    .collection('users')
    .doc(uid)
    .collection('characters')
    .doc(world());
}

function inRange(value: number, range: { min: number; max: number }) {
  return Number.isInteger(value) && value >= range.min && value <= range.max;
}

function rollDie(count: number, sides: number): number[] {
  return Array.from({ length: count }, () => randomInt(1, sides + 1));
}

const signed = (n: number) => (n < 0 ? `${n}` : `+${n}`);

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

// Genkit checks tool input against the JSON schema, so zod transforms such as trim() never run.
const blank = (values: string[]) => values.some((v) => v.trim() === '');
const trimAll = (values: string[]) => values.map((v) => v.trim());

ai.defineTool(
  {
    name: 'getCharacter',
    description:
      "Read the player's character sheet in this world. Returns null when the player has no character yet.",
    inputSchema: z.object({}),
    outputSchema: Character.nullable(),
  },
  async (_input, { context }) => {
    const snap = await characterOf(context.auth.uid).get();
    return snap.exists ? Character.parse(snap.data()) : null;
  },
);

ai.defineTool(
  {
    name: 'createCharacter',
    description: `Create the player character in this world, with up to ${MAX_STARTING_ITEMS} starting items. The server rolls the hit points and the coins.`,
    inputSchema: z.object({
      name: Name,
      role: Name.describe('The class or job, for example Ranger or Pilot.'),
      startingItems: z.array(item()).max(MAX_INVENTORY),
    }),
    outputSchema: z.object({
      outcome: z.enum([
        'created',
        'already_exists',
        'too_many_items',
        'blank_text',
      ]),
      character: Character.optional(),
      maxItems: z.number().optional(),
    }),
  },
  async ({ name, role, startingItems }, { context }) => {
    if (blank([name, role, ...startingItems])) {
      return { outcome: 'blank_text' as const };
    }
    if (startingItems.length > MAX_STARTING_ITEMS) {
      return {
        outcome: 'too_many_items' as const,
        maxItems: MAX_STARTING_ITEMS,
      };
    }
    const ref = characterOf(context.auth.uid);
    return getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        return {
          outcome: 'already_exists' as const,
          character: Character.parse(snap.data()),
        };
      }
      const maxHp = 8 + sum(rollDie(1, 6));
      const character: Character = {
        name: name.trim(),
        role: role.trim(),
        hp: maxHp,
        maxHp,
        coins: sum(rollDie(3, 6)) * 5,
        inventory: trimAll(startingItems),
      };
      tx.create(ref, { ...character, updatedAt: FieldValue.serverTimestamp() });
      return { outcome: 'created' as const, character };
    });
  },
);

ai.defineTool(
  {
    name: 'updateCharacter',
    description: `Change the player's hit points, coins or inventory after something happens in the story. hpChange is a whole number from ${HP_CHANGE.min} to ${HP_CHANGE.max}, coinsChange from ${COINS_CHANGE.min} to ${COINS_CHANGE.max}, and each item list has up to ${MAX_ITEMS_PER_UPDATE} items.`,
    inputSchema: z.object({
      hpChange: z.number(),
      coinsChange: z.number(),
      addItems: z.array(item()).max(MAX_INVENTORY),
      removeItems: z.array(item()).max(MAX_INVENTORY),
    }),
    outputSchema: z.object({
      outcome: z.enum([
        'updated',
        'no_character',
        'invalid_amount',
        'too_many_items',
        'blank_text',
        'missing_item',
        'not_enough_coins',
        'inventory_full',
      ]),
      character: Character.optional(),
      missingItem: z.string().optional(),
      allowed: z
        .object({
          hpChange: range(),
          coinsChange: range(),
          itemsPerUpdate: z.number(),
        })
        .optional(),
    }),
  },
  async (input, { context }) => {
    const allowed = {
      hpChange: HP_CHANGE,
      coinsChange: COINS_CHANGE,
      itemsPerUpdate: MAX_ITEMS_PER_UPDATE,
    };
    if (
      !inRange(input.hpChange, HP_CHANGE) ||
      !inRange(input.coinsChange, COINS_CHANGE)
    ) {
      return { outcome: 'invalid_amount' as const, allowed };
    }
    if (
      input.addItems.length > MAX_ITEMS_PER_UPDATE ||
      input.removeItems.length > MAX_ITEMS_PER_UPDATE
    ) {
      return { outcome: 'too_many_items' as const, allowed };
    }
    if (blank([...input.addItems, ...input.removeItems])) {
      return { outcome: 'blank_text' as const };
    }
    const ref = characterOf(context.auth.uid);
    return getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { outcome: 'no_character' as const };
      const current = Character.parse(snap.data());
      const inventory = [...current.inventory];
      for (const item of trimAll(input.removeItems)) {
        const index = inventory.indexOf(item);
        if (index === -1) {
          return {
            outcome: 'missing_item' as const,
            character: current,
            missingItem: item,
          };
        }
        inventory.splice(index, 1);
      }
      inventory.push(...trimAll(input.addItems));
      if (inventory.length > MAX_INVENTORY) {
        return { outcome: 'inventory_full' as const, character: current };
      }
      const coins = current.coins + input.coinsChange;
      if (coins < 0) {
        return { outcome: 'not_enough_coins' as const, character: current };
      }
      const character: Character = {
        ...current,
        hp: Math.min(current.maxHp, Math.max(0, current.hp + input.hpChange)),
        coins,
        inventory,
      };
      tx.update(ref, { ...character, updatedAt: FieldValue.serverTimestamp() });
      return { outcome: 'updated' as const, character };
    });
  },
);

ai.defineTool(
  {
    name: 'rollDice',
    description: `Roll dice on the server, for example 1d20 with a modifier. Use it for every check and every attack. count is ${DICE.count.min} to ${DICE.count.max}, sides ${DICE.sides.min} to ${DICE.sides.max}, modifier ${MODIFIER.min} to ${MODIFIER.max}.`,
    inputSchema: z.object({
      count: z.number(),
      sides: z.number(),
      modifier: z.number(),
      reason: z.string().max(500),
    }),
    outputSchema: z.object({
      outcome: z.enum(['rolled', 'invalid_dice']),
      rolls: z.array(z.number()).optional(),
      modifier: z.number().optional(),
      total: z.number().optional(),
      allowed: z
        .object({ count: range(), sides: range(), modifier: range() })
        .optional(),
    }),
  },
  async ({ count, sides, modifier }) => {
    if (
      !inRange(count, DICE.count) ||
      !inRange(sides, DICE.sides) ||
      !inRange(modifier, MODIFIER)
    ) {
      return {
        outcome: 'invalid_dice' as const,
        allowed: { ...DICE, modifier: MODIFIER },
      };
    }
    const rolls = rollDie(count, sides);
    return {
      outcome: 'rolled' as const,
      rolls,
      modifier,
      total: sum(rolls) + modifier,
    };
  },
);

ai.defineTool(
  {
    name: 'attemptRiskyAction',
    description: `Attempt a risky action that cannot be undone, such as picking a lock or breaching a vault. The player approves it first. Then the server rolls 1d20 plus the modifier against the difficulty, and a failure costs the player 1d4 hit points. difficulty is ${DIFFICULTY.min} to ${DIFFICULTY.max}, modifier ${MODIFIER.min} to ${MODIFIER.max}. Call attemptRiskyAction at most once per reply, and wait for its result before the next risky action.`,
    inputSchema: z.object({
      action: z.string().min(1).max(200),
      onFailure: z.string().min(1).max(200),
      difficulty: z.number(),
      modifier: z.number(),
    }),
    outputSchema: z.object({
      outcome: z.enum([
        'declined',
        'success',
        'failure',
        'invalid_check',
        'blank_text',
        'no_character',
      ]),
      roll: z.number().optional(),
      total: z.number().optional(),
      damage: z.number().optional(),
      character: Character.optional(),
      allowed: z.object({ difficulty: range(), modifier: range() }).optional(),
    }),
  },
  async (input, { context, interrupt, resumed }) => {
    if (blank([input.action, input.onFailure])) {
      return { outcome: 'blank_text' as const };
    }
    if (
      !inRange(input.difficulty, DIFFICULTY) ||
      !inRange(input.modifier, MODIFIER)
    ) {
      return {
        outcome: 'invalid_check' as const,
        allowed: { difficulty: DIFFICULTY, modifier: MODIFIER },
      };
    }
    if (!resumed) {
      interrupt({
        kind: 'approval',
        summary: `${input.action.trim()} (needs ${input.difficulty} on 1d20${signed(input.modifier)})`,
        onFailure: `${input.onFailure.trim()} You lose 1d4 hit points.`,
      });
    }
    if (typeof resumed !== 'object' || resumed?.approved !== true) {
      return { outcome: 'declined' as const };
    }
    const ref = characterOf(context.auth.uid);
    return getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { outcome: 'no_character' as const };
      const current = Character.parse(snap.data());
      const [roll] = rollDie(1, 20);
      const total = roll + input.modifier;
      if (total >= input.difficulty) {
        return {
          outcome: 'success' as const,
          roll,
          total,
          character: current,
        };
      }
      const [damage] = rollDie(1, 4);
      const character: Character = {
        ...current,
        hp: Math.max(0, current.hp - damage),
      };
      tx.update(ref, {
        hp: character.hp,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'failure' as const, roll, total, damage, character };
    });
  },
);
