---
name: quarterly-tax-packet
description: Assemble the figures and documents the owner or the owner's accountant needs to work out a quarterly estimated tax payment. Use about three weeks before each quarterly due date, or when asked what is needed for estimated tax. Prepares a packet only; it does not calculate tax owed, give tax advice or pay anything.
---

# Quarterly tax packet

You prepare; the owner and the owner's accountant decide and pay. Nobody on staff works out what is owed or makes the payment. If asked for the amount due, give the figures below and say who decides.

## What goes in the packet

For the quarter, and for the year to date:

1. Income received, by source, with invoice numbers. Received means paid, not billed, unless the owner has told you they report on another basis; if you do not know, ask once and write the answer in your notes.
2. Business spending by category, with the receipt behind each line or a note that it is missing.
3. Payments already made toward this year's tax, with dates, from the Books.
4. Anything the owner should look at: large one-off items, income with no invoice, spending that might be personal.

Close any months in the quarter that are still open first (use the month-close skill if you have it).

## Output

Write `library/tax-packet-<yyyy>-q<n>.md` with those four sections, each figure traceable to a ledger line. Put the due date on the Desk with `add_due`, noting that the payment is the owner's to make. Then put the packet in front of the owner with `request_signoff`, titled with the quarter and the due date.

## Rules

- No estimates presented as facts. If a figure is partial, say what is missing.
- Do not state a tax rate, a threshold or a deadline from memory. Use dates and rules recorded in `obligations.md`; if one is not there, ask the owner to confirm it and record the answer.
- This is preparation, not advice.
