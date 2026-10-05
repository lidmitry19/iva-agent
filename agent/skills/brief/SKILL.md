---
name: brief
description: "Brief — the owner's day in review: tasks, calendar, mail, Telegram, every Connection and plugin, goals from CORE, weather. Load in a scheduled Brief turn (08:30 and 14:00 by default), on /digest, and when the owner asks for a day plan, a review of the day or their open tasks."
---

# Brief — the owner's day in review

A Brief comes twice a day by schedule (`iva proactive show` → `briefTimes`) and on
`/digest` or a request in chat. Your job is the judgement: what of the day matters
and what the next step is.

## Gather

In a group chat (`/digest` there) other people read the answer: show only the open
tasks (step 1), nothing from mail, calendar, personal Telegram or Connections.

Walk everything the owner has connected, with your own tools, read only:

1. Tasks: load `task-management`, call `tasks` with `action="list", verifyBitrix=true`. Use this returned list only:
   linked Bitrix tasks are checked live, closed or unavailable tasks are omitted.
   Include its `warning` in the overview when present; a Bitrix failure never stops
   the other sources below. `supposed_completed` means awaiting review, and
   `deferred` is not the focus of the day. Do not recover omitted tasks from memory. Overdue and due
   today first, then high priority, then the rest. Read old relative deadlines from
   `createdAt` as that skill says; an unclear deadline is shown as written, with a
   question, not dropped.
2. Calendar and mail (`google-workspace`), personal Telegram (`telegram-userbot`):
   today's meetings, letters and chats that wait for the owner.
3. Every Connection and plugin: `connection_search` lists them; look at each one for
   what is new or due today.
4. Goals from CORE: one concrete step towards a goal today, if one fits.
5. Weather for the owner's city (from memory, `memory_search`). No city known — ask
   once and save the answer with `write_card`.
6. Habits — only the ones the owner named; never invent a routine.
7. Mail, calendar or Telegram not connected — offer to connect it once and save the
   fact that you offered with `write_card`; next time check memory and do not repeat.

## Write

- Unfixed failures from the prompt are the first points of the overview, before
  anything else: what broke and the cause in one line each, and a «Починить»
  button per failure (see the watch skill).
- The first message is the overview: greeting in one line, the day in 5–7 points,
  one sentence with the focus of the day. Too many tasks — the important ones and
  how many more there are.
- After it, one message per item that needs an action from the owner (an answer, a
  decision, a payment), each with its next step and buttons (see `rich-replies`).
  Items without an action stay in the overview.
- In a scheduled Brief turn separate the messages with a line `<!-- iva:next -->`.
  In a chat turn (`/digest`, a question) the answer is one message, no separators.
- The morning Brief (slot 0) always has an answer. A later Brief may return exactly
  `QUIET` when nothing changed since the morning that is worth a message.

Never send anything yourself in a scheduled turn: no Telegram tools, no `iva post`,
no mail. Code sends your final text to the owner's private chat. Never write to
anyone on the owner's behalf.
