---
name: month-close
description: Close a month in the Books for a sole operator with consulting income and several small software projects. Use at the start of each month, or when asked whether the books are up to date, what was earned or spent last month, or what is still unpaid.
---

# Close the month

Closing a month means every transaction in it is recorded once, has a category, and can be traced to a document. The result is a short summary the owner can read in a minute.

## Steps

1. **Gather.** List what you have for the month: the ledger file, invoices sent, receipts filed, and any statements the owner has put in Drive or the Books. If a statement is missing, say which, and carry on with what you have.
2. **Match.** For each statement line find the ledger entry and the document behind it. Mark each line matched, missing a receipt, or unexplained.
3. **Record.** Add ledger entries for anything matched to a document but not yet recorded. One line each: date, payee or payer, amount, category, document.
4. **Separate.** Tag every entry as consulting, a named software project, or personal. If you cannot tell, list it under "to sort" for the owner. Do not decide which pocket something came from.
5. **Check.** Opening balance plus the month's movement should equal the closing balance on the statement. If it does not, find the difference before going further and report it exactly.
6. **Receivables.** List invoices still unpaid with their age in days.

## The summary

Write `library/close-<yyyy-mm>.md`:

- income by source, spending by category, the net
- unpaid invoices and their age
- the "to sort" list and anything missing a receipt
- anything unusual next to last month, with the figure

Then log it with `report_done`, with the count of entries and the one figure that matters most.

## Rules

- Never invent a category, a payee or an amount to make things balance. An unexplained line stays unexplained and is reported.
- Changes to the Books go through the office like any other change; if yours need a signature, batch them into one request.
- You do not move money and you do not file anything.
