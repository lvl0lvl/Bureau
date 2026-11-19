# Design brief

Designs live in Paper, file **Bureau**, page **Screens**
(https://app.paper.design/file/01M7AXFXDVR5BAMDCHS8DAN458/p-1-0).
Design tokens are defined in that file; the values below mirror them.

## Direction

**Mood: drafting table.** Every engineering drawing carries a sign-off block (prepared, checked,
approved). That is how this team works, so it is the organizing device of the interface.
A strict white Swiss layout where the one loud thing is the owner's handwritten signature in blue.

Rejected: cream paper with a serif and a red stamp (the current AI-design default), dark mode
with one neon accent, and anything resembling Grok Bot (blob avatars, pink and orange bubbles).

## Palette

| Token | Value | Scene reference | Meaning |
|---|---|---|---|
| `--color-ground` | `#FFFFFF` | drafting film | page |
| `--color-ink` | `#000000` | black lead | text, strong lines, unsigned slips |
| `--color-graphite` | `#5A5F66` | pencil | secondary text |
| `--color-rule` | `#D5E4F0` | non-photo blue | hairlines, settled items |
| `--color-wash` | `#F3F7FB` | tracing paper | quoted material |
| `--color-blue` | `#1D3FE3` | blueprint | the owner: the signature, the owner's words, primary actions |
| `--color-red` | `#E0362C` | checker's red pencil | needs the owner |
| `--color-yellow` | `#FFE14D` | highlighter | work in progress right now |

Color carries meaning only. Nothing is colored for decoration. One exception, at the owner's request
(2026-11-13): a member of staff may be given a bubble color to tell people apart, from a fixed
set that leaves out blue, red and yellow so those keep their meaning.

## Type

- **Archivo** for everything. 800 to 900 for display, 700 for titles, 400 to 600 for text.
- **Archivo Narrow** for figures in lanes: dates, times, amounts, counts.
- **Nothing You Could Do** for the owner's signature only.
- Scale: 40 to 44 display, 28 heading, 17 to 18 title, 14 to 15 body, 13 caption, 12 minimum.

## Themes

The drafting table is the design and the default. Four more looks were added at the owner's
request (2026-11-15), each built from a reference picture the owner supplied. They are chosen
per device under Appearance in Settings, so a phone and a Mac can differ.

| Theme | Idea | Type | Owner / needs you / working |
|---|---|---|---|
| Drafting table | white film, black lead | Archivo | blue `#1D3FE3`, red `#E0362C`, yellow `#FFE14D` |
| Graph paper | dot grid, square corners, a blue and lime band on each slip | JetBrains Mono | blue `#1C3CFF`, red `#F0341F`, lime `#C9F23F` |
| Night shift | dark slate, frosted panels, round corners | Inter, Inter Tight for display | sky blue `#62ADFF`, orange `#FF8A3D`, teal `#25B6CC` |
| Control room | amber on black, inverse-video title bars, scan lines | IBM Plex Mono, VT323 for display | pale amber `#FFF1C9`, red `#FF5A36`, amber `#F4B92F` |
| Stationery | off-white paper, dark outlines, big radii, green, lilac and cream fills | Nunito | green `#1F8553`, red `#D63546`, butter `#FBD67A` |

What a theme may change: colors, typefaces, corner radius, the ground behind the page, and the
dress of buttons, tabs and slips. What it may not: layout, copy, and the three meanings. Every
theme has a color for the owner, one for "needs you" and one for "working now", and the three
can always be told apart at a glance. In Control room, where everything is amber, working now is
a filled bubble against outlined ones. Staff stay circles and the owner stays a square. Copy never names a color
(the calendar's key shows the edge itself), because the color is the theme's to choose.

A theme is a block of token overrides in `apps/web/src/styles/themes.css` keyed on
`data-theme` on the page, plus a row in `apps/web/src/lib/theme.ts` for the picker. Components
use tokens only: `--surface` for panels, `--edge` for structural lines, `--round` to scale
every radius, `--blue-fill` and `--on-blue` for filled controls, `--display` for headings.
Adding a theme should not need a change outside those two files and the inline script in
`apps/web/index.html` that applies the choice before the first paint.

The earlier rejection of "dark mode with one neon accent" stands for the default. Night shift
and Control room exist because the owner asked for them; neither follows the system's
dark-mode setting.

## Devices

- **Sign-off slip:** title and one-line detail on the left; on the right a block of
  Prepared, Checked, Signed. Unsigned slips have a black border, a red dot and an empty
  signature line. Signed slips go quiet (rule-blue border) and carry the signature.
- **Staff bubbles:** a lettered circle, like the grid bubbles on a plan. Yellow fill means
  working now; on a bubble that has its own color, a yellow ring means the same. In the sidebar
  a red ring means that person is waiting on the owner (it replaced a red dot at the end of the row).
  On a phone the same bubbles run across the top of the Desk, under the wordmark and date, with
  each name beneath: the chief of staff first, then whoever is waiting on the owner, whoever is
  working, and the most recently active. When they do not all fit, the last place is a count
  ("+2", "Everyone") that opens the Staff page, and it takes the red ring if someone it hides is
  waiting. The Staff page's list of people on a phone uses the same order; the authority table
  keeps fixed columns.
- **Calendar:** the title carries its views beside it as plain text tabs with an ink underline
  (Week, Month, Everything, On a schedule; Week opens first). The list of what is due sits on
  top and the grid below it. Choosing a day in the grid turns the list into that day. Due dates
  are solid entries with an ink edge, red when they need the owner or are late; duties staff run by
  themselves are lighter. Weeks run Sunday to Saturday. Today is an ink circle. On a phone the
  grid shows marks instead of text. Appointments copied from the owner's Google Calendar have a
  blue edge and a small blue square where a due date has its checkbox (blue is the owner's).
  With a day chosen, an ink button beside the day's name goes back to the whole week or month.
- **Lanes:** repeated rows keep fixed-width slots for time, text and owner.
- **Authority levels:** four steps (Watch, Draft, Ask first, Act and report). Locked actions
  are hatched.
- **Transcript:** set like minutes (time, speaker, text), not chat bubbles. The owner's words are
  in blue ink.

## Copy rules

Sentence case. No all-caps labels, no middle-dot strings, no arrows on buttons. Buttons say
what happens ("Sign and send"). Name things the way the owner would ("To sign", "Coming due").

## Built versus designed

The build follows the six screens. Where it differs, and why:

- The authority matrix lists the classes the gate can enforce (see `docs/decisions.md`), not the
  looser labels in the mock-up.
- The Thread mock-up shows a table of charges with Business and Personal buttons. The build shows
  such questions as a question slip with options; there is no table row type yet.
- Search within a thread is not built. The attach button is built as a plus at the left of the
  message box; attached files show as chips above it and as a list under the sent message.
- A proposed rule is a slip like any other, with "A rule for" and "Drawn from" where an action
  slip has "Prepared" and "Checked". The rule itself sits in the wash panel as the draft.
- The week (`/week`) is not in the Paper designs: four large Archivo Narrow figures on an ink
  rule, a table by person, what was flagged, and the finished list. Red is used only for a
  declined count and for usage at the limit.
- Usage and conversation size are not in the Paper designs. They were added to the build at the
  foot of the sidebar and as one line above the phone's message box: ink bars on a rule-colored
  track, a mark at the hold limit, red only when the limit is reached (red means it needs the owner).
  Conversation size stays ink at any level, since compaction needs nothing from the owner.
- On a phone the tabs are Desk, Work, Staff, Books and Calendar, then the owner's blue square,
  which opens Settings (as the square at the foot of the sidebar does). Artifacts and The week
  have no tab; they are linked under the Settings title on a phone.
- The lock-screen design is realised as real notifications (Web Push and Apple Push), which the
  system draws.

Screenshots of the running build are in `docs/built/`. They are taken from a demo office whose
owner is the invented Robin Hale (`BUREAU_OWNER="Robin Hale" pnpm start:demo` on another port,
then `scripts/dev/drive.mjs`).

## Screens

First pass designed 2026-11-13. The Paper file is the source of truth. PNG exports of the first
pass are kept in `docs/design/screens/` in the designer's own checkout only; the build
screenshots show what was made of them.

| Artboard in Paper | Export | Shows |
|---|---|---|
| Desk | `01-desk.png` | Morning brief, slips to sign, working now, coming due, done |
| Thread | `02-thread.png` | Conversation with Tally, work log, duties, authority, record |
| Staff | `03-staff-authority.png` | "Who may do what" matrix, pending promotion |
| Phone, Desk | `04-phone-desk.png` | The Desk on iPhone |
| Phone, signed | `05-phone-signed.png` | A slip just signed with Face ID, undo window |
| Phone, lock screen | `06-phone-lock-screen.png` | Sign from a notification |

Not designed yet: Books, Calendar, Artifacts, hiring a staff member, settings, the iPhone thread
view, empty and error states. The themes above were built in code and are not in Paper.

Details settled while designing:

- The authority matrix uses bars of four lengths rather than pips; a blue outlined segment
  marks a proposed promotion. The Thread side panel still uses four pips. Pick one before build.
- Only the chief of staff checks work, and whoever reads outside mail never checks what it asks
  for, so Wren has no inbox authority.
- Sending waits a few seconds after signing so it can be undone.
- The owner is a blue rounded square; staff are circles.

Placeholder staff: Wren (chief of staff), Tally (books), Piper (inbox), Atlas (research),
Hearth (personal), Forge (projects and scripts).
