---
name: invoice-a-client
description: Prepare and send an invoice for consulting or training work by a sole operator. Use when the owner asks to invoice someone, when a job in the ledger is finished and unbilled, or when checking what is still owed.
---

# Invoice a client

An invoice is finished when it has been sent, recorded in the Books, and has a date on the Desk for when payment is due.

## Before you write anything

1. Find the job in the Books (`ledger/` for the month, `contacts.md` for who to bill). If the client, the amount or what was delivered is not written down, ask the owner one question that settles it. Do not guess a rate.
2. Find the last invoice number in `accounts.md` or the ledger and take the next one. Numbers never repeat and never skip.
3. Check the terms the owner uses with this client. If none are recorded, use net 30 and say so.

## The invoice

Write it to `library/invoice-<number>.md` with:

- the owner's name and how to pay (from `accounts.md`; if it is not there, ask)
- the client's name and the person or desk it goes to
- invoice number, issue date, due date
- one line per thing delivered: date, plain description, quantity, rate, amount
- expenses passed on, each with its receipt named
- the total, and the terms in a sentence

Check the arithmetic by adding the lines again from scratch.

## Sending it

Send it to the billing contact from the Books with a two or three sentence note: what it is for, the total, when it is due. Attach or include the invoice. Sending needs the owner's signature unless you have been given authority to write to this contact.

## Afterwards

- Add a line to this month's ledger: date, invoice number, client, amount, due date, status "sent".
- Put the due date on the Desk with `add_due`.
- If a due date passes unpaid, draft one polite reminder and bring it to the owner. Do not send a second without asking.

You never record an invoice as paid on someone's word. Paid means the owner told you, or you were shown the deposit.
