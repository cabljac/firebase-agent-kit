import { ai, z } from '@cabljac/firebase-agent-kit';
import {
  type DocumentSnapshot,
  FieldValue,
  getFirestore,
  Timestamp,
} from 'firebase-admin/firestore';

const REFUND_WINDOW_DAYS = 30;

const OrderId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe('The order id, for example A1001.');

const Order = z.object({
  id: z.string(),
  status: z.enum(['processing', 'shipped', 'delivered', 'cancelled']),
  items: z.array(z.object({ name: z.string(), quantity: z.number() })),
  total: z.number(),
  currency: z.string(),
  placedAt: z.string(),
  deliveredAt: z.string().optional(),
  refundable: z.boolean(),
});
type Order = z.infer<typeof Order>;

function ordersOf(uid: string) {
  return getFirestore().collection('users').doc(uid).collection('orders');
}

function dateOf(value: unknown): Date | undefined {
  return value instanceof Timestamp ? value.toDate() : undefined;
}

function toOrder(snap: DocumentSnapshot): Order {
  const data = snap.data() ?? {};
  const deliveredAt = dateOf(data.deliveredAt);
  const refundDeadline = deliveredAt
    ? deliveredAt.getTime() + REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000
    : 0;
  return Order.parse({
    ...data,
    id: snap.id,
    placedAt: dateOf(data.placedAt)?.toISOString(),
    deliveredAt: deliveredAt?.toISOString(),
    refundable: data.status === 'delivered' && Date.now() < refundDeadline,
  });
}

ai.defineTool(
  {
    name: 'listOrders',
    description: "List the caller's 10 most recent orders, newest first.",
    inputSchema: z.object({}),
    outputSchema: z.array(Order),
  },
  async (_input, { context }) => {
    const snaps = await ordersOf(context.auth.uid)
      .orderBy('placedAt', 'desc')
      .limit(10)
      .get();
    return snaps.docs.map(toOrder);
  },
);

ai.defineTool(
  {
    name: 'lookupOrder',
    description:
      "Look up one of the caller's orders by id. Returns null when the caller has no order with that id.",
    inputSchema: z.object({ orderId: OrderId }),
    outputSchema: Order.nullable(),
  },
  async ({ orderId }, { context }) => {
    const snap = await ordersOf(context.auth.uid).doc(orderId).get();
    return snap.exists ? toOrder(snap) : null;
  },
);

ai.defineInterrupt({
  name: 'approveRefund',
  description:
    'Ask the customer to confirm a refund request before you file it with requestRefund.',
  inputSchema: z.object({
    orderId: OrderId,
    amount: z.number(),
    currency: z.string(),
  }),
  outputSchema: z.object({ approved: z.boolean() }),
});

ai.defineTool(
  {
    name: 'requestRefund',
    description:
      "File a refund request for one of the caller's orders. Call it only after approveRefund returns approved: true, with the amount the customer approved.",
    inputSchema: z.object({
      orderId: OrderId,
      amount: z.number(),
      reason: z.string().min(1).max(500),
    }),
    outputSchema: z.object({
      outcome: z.enum([
        'requested',
        'already_requested',
        'not_found',
        'not_refundable',
        'amount_mismatch',
      ]),
      amount: z.number().optional(),
      currency: z.string().optional(),
    }),
  },
  async ({ orderId, amount, reason }, { context }) => {
    const db = getFirestore();
    const orderRef = ordersOf(context.auth.uid).doc(orderId);
    const requestRef = db
      .collection('users')
      .doc(context.auth.uid)
      .collection('refundRequests')
      .doc(orderId);
    return db.runTransaction(async (tx) => {
      const [orderSnap, requestSnap] = await tx.getAll(orderRef, requestRef);
      if (!orderSnap?.exists) return { outcome: 'not_found' as const };
      if (requestSnap?.exists) return { outcome: 'already_requested' as const };
      const order = toOrder(orderSnap);
      if (!order.refundable) return { outcome: 'not_refundable' as const };
      if (amount !== order.total) {
        return {
          outcome: 'amount_mismatch' as const,
          amount: order.total,
          currency: order.currency,
        };
      }
      tx.create(requestRef, {
        orderId,
        reason,
        amount: order.total,
        currency: order.currency,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
      });
      return {
        outcome: 'requested' as const,
        amount: order.total,
        currency: order.currency,
      };
    });
  },
);
