---
description: How to handle a refund request, from eligibility to filing it.
---
# Refunds

1. Find the order with lookupOrder, or with listOrders when the customer does not know the id.
2. Check the `refundable` field. Only delivered orders within 30 days of delivery are refundable.
   - Not delivered yet: offer help with shipping instead.
   - Past 30 days: say that the order is outside the refund window. Do not make exceptions.
3. Ask for the reason in one short question, if the customer has not given one.
4. Call approveRefund with the order id, the order total and the currency. Never change the amount.
5. If the customer approves, call requestRefund with the approved amount. If not, confirm that nothing was filed.
   - `amount_mismatch` means the amount was not the order total. Ask again with approveRefund and the total that requestRefund returned.
6. Tell the customer the outcome. The team reviews a filed request within 2 business days, and the money goes back to the original payment method.
