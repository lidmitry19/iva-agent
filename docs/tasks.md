# Tasks and due dates

Ask Iva to add a task, list your tasks, change a deadline, or mark a task done.
Tasks live in `data/tasks.json` (`ASSISTANT_DATA_DIR` when configured). They survive
restarts and updates. A task deadline is a calendar day, not a scheduled reminder;
ask for a reminder separately when you need a message at a particular time.

New deadlines are stored as real calendar dates in `YYYY-MM-DD` form. Iva interprets
relative phrases using your current date and timezone before calling the tool:
"tomorrow" on September 23 becomes `2026-09-24`. A task without a deadline stores `null`.
Past dates are allowed so overdue work remains visible. Invalid dates and relative
strings are rejected instead of being saved as moving deadlines.

Older installations can contain deadlines such as `"завтра"`. Updating Iva does
not rewrite or remove those tasks. For a Brief, Iva interprets an old relative
deadline from the task's `createdAt`, using your timezone **at creation**. If that
timezone or the original request is unknown, she asks instead of guessing. An
unresolved deadline is shown explicitly, rather than classified as no deadline.

To repair an old deadline, ask Iva to change it to the confirmed date. The `tasks`
tool supports `update` with `id`, `due` and `expectedDue`, the exact old value from
`list`. For example:

```json
{ "action": "update", "id": 117, "due": "2026-09-24", "expectedDue": "завтра" }
```

Use `due:null` to clear a deadline and `expectedDue:null` when it previously had
none. The tool rejects the change if another turn changed that deadline after
it was read; Iva must reread it before proceeding. Other task fields are preserved.

The JSON row shape is unchanged. Older versions can still read dates written by
this version after a rollback; they can also write relative strings again, which
remain readable when you upgrade. There is no background migration. The supplied
tool and skills require a rebuild and restart after source changes under `agent/`;
the normal `iva update` path performs that build.
