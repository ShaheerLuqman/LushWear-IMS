I want you to implement a complete **Postex Courier Ledger and Automated CSV Reconciliation System** inside my existing software.

Please understand the business logic below exactly and build the feature around it.

## 1. Basic Business Scenario

I use courier companies such as **Postex** and **Courier Next** to deliver orders.

Every day, I hand over a new batch of COD orders to Postex.

For example:

- Day 1: I give Postex orders worth Rs. 10,000
- Day 2: I give Postex orders worth Rs. 10,000
- Day 3: Rs. 10,000
- Day 4: Rs. 10,000
- Day 5: Rs. 10,000
- Day 6: Rs. 10,000

So, after six days, I have handed over a total of:

**Rs. 60,000 worth of orders to Postex.**

Every time I dispatch/handover orders to Postex, the system should automatically create the appropriate accounting/ledger entry in the **Postex Ledger**.

Therefore, after six days, before any payment or adjustment, the Postex ledger should show approximately:

**Postex Accounts Receivable = Rs. 60,000**

The important point is that these are separate daily transactions, not one combined transaction. The system must preserve the individual order/batch/date-level records while also maintaining the total running balance.

---

# 2. Weekly/Six-Day Payment Cycle

Postex operates on a payment cycle.

After six days of order activity, on the seventh day Postex sends me a payment.

For example:

Total orders handed over during the six-day cycle:

**Rs. 60,000**

On Day 7, Postex sends me a bank payment of:

**Rs. 30,000**

The payment is actually received in my bank account.

However, Postex also provides a CSV/report that explains how this payment and the related orders have been settled/adjusted.

The CSV may contain information such as:

1. Actual payment received
2. Delivery charges deducted
3. Taxes deducted
4. Returned orders / COD amounts adjusted
5. Other relevant adjustments if applicable

The system needs to automatically process this CSV and post the corresponding accounting entries.

---

# 3. Example of the CSV Settlement

Suppose Postex sends:

**Actual bank payment = Rs. 30,000**

And the CSV explains:

- Payment received: Rs. 30,000
- Delivery charges: Rs. 2,500
- Taxes: Rs. 2,500
- Returned orders / COD adjustment: Rs. 5,000

Therefore:

30,000 + 2,500 + 2,500 + 5,000 = **Rs. 40,000**

This means Postex has settled/adjusted a total of **Rs. 40,000** against my Rs. 60,000 receivable.

Therefore, my remaining outstanding balance with Postex should become:

**Rs. 60,000 - Rs. 40,000 = Rs. 20,000**

So the Postex ledger should ultimately show:

**Outstanding Receivable = Rs. 20,000**

This Rs. 20,000 is the amount I should still be able to ask Postex about: 

"Rs. 20,000 is still outstanding. When will you pay this?"

---

# 4. Required Ledger Entries

When the Postex CSV is uploaded, the system should automatically create the following four types of accounting entries.

## Entry 1 — Actual Payment Received

If Postex actually deposits Rs. 30,000 into my bank:

**Bank Account Dr. Rs. 30,000**  
**Postex Accounts Receivable Cr. Rs. 30,000**

This reduces the Postex receivable by Rs. 30,000.

---

## Entry 2 — Delivery Charges

If Postex's CSV says that Rs. 2,500 was deducted as delivery charges:

**Courier/Delivery Charges Expense Dr. Rs. 2,500**  
**Postex Accounts Receivable Cr. Rs. 2,500**

This represents a cost that I incurred and will not receive from Postex.

---

## Entry 3 — Taxes

If the CSV says Rs. 2,500 was deducted as taxes:

**Taxes Expense / Applicable Tax Account Dr. Rs. 2,500**  
**Postex Accounts Receivable Cr. Rs. 2,500**

This amount is also no longer receivable from Postex.

---

## Entry 4 — Returned Orders Adjustment

If Postex reports that orders worth Rs. 5,000 have been returned and therefore their COD amount will not be paid as part of this settlement:

**Returns / Sales Return Adjustment Dr. Rs. 5,000**  
**Postex Accounts Receivable Cr. Rs. 5,000**

The exact debit account should be configurable according to the accounting structure already used by the software.

The important requirement is that the Rs. 5,000 must be removed from the Postex receivable because those orders have been returned and their COD amount is no longer collectible as part of the original receivable.

---

# 5. Core Reconciliation Logic

The most important requirement is that the system must distinguish between:

### A. Actual Cash Received

Example:

**Rs. 30,000**

This is the amount that actually reached my bank account.

### B. Settlement Adjustments

Example:

- Delivery charges = Rs. 2,500
- Taxes = Rs. 2,500
- Returns = Rs. 5,000

Total adjustments:

**Rs. 10,000**

### C. Total Receivable Settled

Therefore:

**Rs. 30,000 cash received + Rs. 10,000 adjustments = Rs. 40,000 total settlement**

### D. Remaining Receivable

Original receivable:

**Rs. 60,000**

Less total settlement:

**Rs. 40,000**

Remaining:

**Rs. 20,000**

The system must automatically calculate and display this.

---

# 6. Daily Order Posting

Every time an order is dispatched/handover to Postex, the system should automatically post the transaction to the Postex ledger.

For example:

Day 1:

**Postex Accounts Receivable Dr. Rs. 10,000**  
**Sales/COD Receivable/Relevant Sales Account Cr. Rs. 10,000**

Day 2:

**Postex Accounts Receivable Dr. Rs. 10,000**

Day 3:

**Postex Accounts Receivable Dr. Rs. 10,000**

And so on.

After six days:

**Postex Accounts Receivable = Rs. 60,000**

The system must maintain each individual transaction and not simply overwrite or merge the transactions.

---

# 7. CSV Upload Workflow

I want a dedicated workflow where I can upload the CSV received from Postex.

When I upload a CSV, the system should:

1. Read and parse the CSV.
2. Identify the relevant Postex settlement/payment.
3. Identify the payment amount.
4. Identify delivery charges.
5. Identify taxes.
6. Identify returned orders/COD adjustments.
7. Match the CSV transactions against the orders already recorded in the system.
8. Determine which orders have been delivered.
9. Determine which orders have been returned.
10. Determine which COD amounts have been settled.
11. Automatically create the required accounting/ledger entries.
12. Update the Postex ledger.
13. Recalculate the outstanding Postex receivable.
14. Show a complete reconciliation summary before final posting.
15. Prevent duplicate posting if the same CSV is uploaded more than once.

---

# 8. Important: CSV Preview Before Posting

Before permanently posting accounting entries, show me a reconciliation preview.

For example:

### Postex Settlement — Day 7

| Description | Amount |
|---|---:|
| Opening Postex Receivable | Rs. 60,000 |
| Cash Payment Received | Rs. 30,000 |
| Delivery Charges | Rs. 2,500 |
| Taxes | Rs. 2,500 |
| Returned Orders Adjustment | Rs. 5,000 |
| Total Settled/Adjusted | Rs. 40,000 |
| Remaining Postex Receivable | Rs. 20,000 |

Then show a clear **"Confirm & Post"** button.

Nothing should be permanently posted until I confirm the reconciliation.

---

# 9. Postex Ledger View

The Postex ledger should clearly show:

- Date
- Transaction/reference number
- Order/batch reference
- Description
- Debit
- Credit
- Running balance
- Settlement/CSV reference
- Payment reference
- Order status
- Reconciliation status

Example:

| Date | Description | Debit | Credit | Balance |
|---|---|---:|---:|---:|
| Day 1 | Orders handed to Postex | 10,000 | — | 10,000 |
| Day 2 | Orders handed to Postex | 10,000 | — | 20,000 |
| Day 3 | Orders handed to Postex | 10,000 | — | 30,000 |
| Day 4 | Orders handed to Postex | 10,000 | — | 40,000 |
| Day 5 | Orders handed to Postex | 10,000 | — | 50,000 |
| Day 6 | Orders handed to Postex | 10,000 | — | 60,000 |
| Day 7 | Payment received | — | 30,000 | 30,000 |
| Day 7 | Delivery charges | — | 2,500 | 27,500 |
| Day 7 | Taxes | — | 2,500 | 25,000 |
| Day 7 | Returns adjustment | — | 5,000 | 20,000 |

Final outstanding:

**Rs. 20,000**

---

# 10. Order-Level Reconciliation

The system should preferably reconcile at the individual order level rather than only at the total amount level.

For every order, maintain a status such as:

- Dispatched
- In Transit
- Delivered
- Returned
- Paid/Settled
- Partially Settled
- Unsettled
- Reconciled

When the Postex CSV is uploaded, match its order/tracking number with the order in my system.

For example:

| Order | COD | Status | Delivery Charge | Tax | Settlement |
|---|---:|---|---:|---:|---:|
| Order A | 5,000 | Delivered | 400 | 400 | Settled |
| Order B | 5,000 | Delivered | 400 | 400 | Settled |
| Order C | 5,000 | Returned | — | — | Returned |
| ... | ... | ... | ... | ... | ... |

The exact CSV column names may vary, so build the CSV parser in a configurable/mappable way.

---

# 11. Duplicate Protection

This is extremely important.

If I accidentally upload the same Postex CSV twice, the system must NOT create duplicate accounting entries.

The system should detect duplicate settlements using appropriate identifiers such as:

- CSV file hash
- Settlement ID
- Payment reference
- Transaction ID
- Order IDs
- Settlement date
- Combination of relevant unique fields

If a settlement has already been posted, show:

**"This Postex settlement has already been reconciled/posted."**

Do not post it again unless I explicitly choose to reverse/reprocess it.

---

# 12. Reconciliation Difference / Error Handling

The system should calculate:

**Opening Receivable - Total Settlement Adjustments = Closing Receivable**

If the CSV does not reconcile correctly, do NOT silently post it.

For example, if:

Opening receivable = Rs. 60,000

But CSV says:

Payment = Rs. 30,000  
Delivery charges = Rs. 2,500  
Taxes = Rs. 2,500  
Returns = Rs. 5,000

Total = Rs. 40,000

Then closing receivable = Rs. 20,000.

If the numbers do not make sense because of missing orders, duplicate orders, incorrect COD amounts, or unmatched CSV records, show a clear reconciliation error.

Example:

**Reconciliation Difference: Rs. 3,500**

Then show exactly which orders/transactions are causing the difference.

Never automatically force the ledger to balance without identifying the reason.

---

# 13. Settlement History

Create a settlement history for Postex.

For every CSV settlement, store:

- Settlement date
- Settlement ID
- CSV upload date
- Payment date
- Payment reference
- Bank amount received
- Delivery charges
- Taxes
- Returns adjustment
- Other adjustments
- Total amount settled
- Opening receivable
- Closing receivable
- Number of orders included
- Number of delivered orders
- Number of returned orders
- Reconciliation status
- User who posted it
- Timestamp
- Original CSV/file reference

This should allow me to go back later and audit exactly how every Postex payment was calculated.

---

# 14. Dashboard / Summary

I want a Postex dashboard showing at minimum:

### Total Orders Given
Total COD value of orders handed over to Postex.

### Total Cash Received
Actual money received from Postex.

### Total Delivery Charges
Total delivery charges deducted.

### Total Taxes
Total taxes deducted.

### Total Returns
Total COD value removed because of returned orders.

### Total Settled/Adjusted
Cash received + all valid settlement adjustments.

### Current Outstanding
Amount still receivable from Postex.

For the example above:

**Orders Given: Rs. 60,000**  
**Cash Received: Rs. 30,000**  
**Delivery Charges: Rs. 2,500**  
**Taxes: Rs. 2,500**  
**Returns: Rs. 5,000**  
**Total Settled/Adjusted: Rs. 40,000**  
**Outstanding: Rs. 20,000**

---

# 15. Multiple Courier Companies

Do not hard-code this functionality only for Postex.

The accounting/reconciliation engine should be designed so that I can use the same system for:

- Postex
- Courier Next
- Other courier companies in the future

Each courier may have a different CSV format, different settlement cycle, different fee structure, and different column names.

Therefore, create a configurable **Courier Settlement Integration/Reconciliation System**.

Postex should be the first implementation.

---

# 16. Accounting Integrity

The system should maintain proper double-entry accounting.

Every automatically generated transaction must have:

- Debit account
- Credit account
- Amount
- Date
- Reference
- Source
- Courier
- Settlement ID
- Order reference where applicable

All automatically generated ledger entries should be traceable back to the original order or CSV settlement.

If an already-posted CSV needs correction, do not simply delete accounting history. Use an appropriate reversal/adjustment mechanism so the audit trail remains intact.

---

# 17. Key Business Rule

The most important rule to implement is:

**The courier's outstanding balance must not be reduced only by the cash received.**

It must be reduced by:

**Cash Payment Received + Valid Courier Deductions/Adjustments + Valid Returned COD Adjustments + Other approved settlement adjustments**

Therefore:

**Closing Receivable = Opening Receivable - Cash Received - Delivery Charges - Taxes - Returns - Other Valid Adjustments**

For the example:

**60,000 - 30,000 - 2,500 - 2,500 - 5,000 = 20,000**

So the final Postex ledger balance is:

**Rs. 20,000 outstanding.**

---

# 18. User Experience

The workflow should be as simple as possible:

### Step 1
I dispatch/handover orders to Postex.

→ System automatically posts them to Postex Accounts Receivable.

### Step 2
After the settlement period, Postex sends me money and a CSV.

### Step 3
I upload the CSV.

### Step 4
System automatically reads and reconciles it.

### Step 5
System shows me:

**"Rs. 30,000 received + Rs. 10,000 adjustments = Rs. 40,000 settled. Rs. 20,000 remains outstanding."**

### Step 6
I review the details.

### Step 7
I click:

**Confirm & Post**

### Step 8
The four accounting entries are posted automatically and the Postex ledger is updated.

---

# 19. Implementation Requirements

Please inspect the existing application's architecture, database schema, accounting/ledger system, order system, courier integration structure, and file-upload functionality before implementing this.

Do not create a disconnected parallel accounting system if an existing ledger/accounting framework already exists.

Reuse the existing:

- Chart of Accounts
- Journal/ledger engine
- Order database
- Courier/order tracking data
- Payment/bank transaction system
- Authentication/permissions
- Audit logging
- File storage
- UI components

The new feature should integrate cleanly with the existing software.

Please implement this as a production-ready feature, including:

- Database changes/migrations
- Backend logic
- CSV parsing
- CSV column mapping
- Order matching
- Reconciliation engine
- Double-entry ledger posting
- Duplicate protection
- Error handling
- Audit trail
- Settlement history
- Postex ledger view
- Dashboard/summary
- Confirmation workflow
- Tests
- Appropriate permissions
- Clear user-facing error messages

Before finalizing, test the complete example above end-to-end and verify that:

**Rs. 60,000 initial receivable  
− Rs. 30,000 cash received  
− Rs. 2,500 delivery charges  
− Rs. 2,500 taxes  
− Rs. 5,000 returns  
= Rs. 20,000 final outstanding receivable.**

The final system should make it very easy for me to answer:

**"How much money is currently outstanding from Postex, how much have they actually paid me, what deductions have they made, which orders were returned, and exactly how did we arrive at the current balance?"**