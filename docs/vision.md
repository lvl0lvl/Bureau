# Vision

## Who it is for

One person who runs their own working life: a small business or a few projects, clients,
and the personal administration and finances that come with them. Someone who lives in Gmail,
Google Calendar and Google Drive, already pays for a Claude subscription, and wants a team that
is impressive to show other people and also does real work.

## The idea

An office, not a chat app. If a team runs your business and personal affairs, you should not
have to visit five chat threads to learn what is going on. The hard problem is trust.

## Core elements

**The Desk.** The home screen. Everything that needs the owner (sign-offs, questions, drafts),
what got done with receipts, and what is coming due. Cleared in two minutes from a phone.
Chat threads exist, but you go to them by choice.

**Chief of staff.** One staff member the owner talks to, in the app or over iMessage, who routes
work to specialists. Staff-to-staff conversations stay visible for audit.

**Responsibilities, not prompts.** Each staff member holds standing duties ("reconcile accounts
weekly", "track every renewal and filing date"). Each duty shows last done, next due, health.

**Earned authority.** Every staff member starts by drafting only. The app keeps a track record
and proposes promotions ("23 of 23 categorizations approved unchanged; let Tally file these
without asking?"). Authority is per kind of action, visible on one page, revocable.
Levels: Watch, Draft, Ask first, Act and report. Some actions are locked at Never.

**Sign-off.** Each item needing the owner is a slip with a sign-off block: prepared by one staff
member, checked by another, signed by the owner. Shows where the request originated.

**The Books.** Shared records the whole team works from (accounts, contacts, vendors,
obligations) as plain files on the Mac under version history, so every change is visible and
can be undone.

**Hard lines.** Staff prepare payments and filings; the owner executes them.

**Reading is separate from acting.** Staff that read untrusted content (inbox, web) do not hold
authority to send or pay.

## Starting roster (names are placeholders)

| Name | Role | Typical duties |
|---|---|---|
| Wren | Chief of staff | Morning brief, routing, checking others' work |
| Tally | Books and finance | Categorize, reconcile, invoices, tax dates |
| Piper | Inbox and correspondence | Triage Gmail, draft replies, scheduling |
| Atlas | Research | Investor and market research, due diligence |
| Hearth | Personal and home | Insurance, renewals, appointments, travel |
| Forge | Projects and scripts | Software project chores, Python jobs |

## What a bot is, technically

A folder on the Mac (instructions, memory, skills, Library) plus a resumable Claude Code
session, driven through the Claude Agent SDK. See `docs/decisions.md`.
