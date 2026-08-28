# Backlog

## Timeline and task presentation

### NC-001: Show meaningful task lifecycle states

**Status:** Proposed

Task rows currently tend to remain yellow, which makes completed work look permanently active and
duplicates information already represented by related tool rows.

**Proposed behavior**

- Keep one stable timeline row per task ID.
- Show queued and running tasks in yellow.
- Update the same row to green when completed, red when failed, and gray when cancelled.
- Do not append a second completion row; completion details belong in the task detail view.
- Delay the initial yellow row briefly, approximately 300-500 ms.
  - If the task is still active after the delay, show the yellow row.
  - If it finishes before the delay, insert only its final green or red state to avoid a yellow flash.
- Keep the row at its original chronological position and retain its creation timestamp.
- Show elapsed duration or a concise terminal detail on completion when available.

**Investigation**

- Confirm which terminal task states the Copilot SDK emits.
- Determine whether completed tasks receive an explicit update or simply disappear from task snapshots.
- Define how a disappeared running task should be reconciled without falsely reporting success.
- Confirm whether task and tool IDs can be linked reliably enough to avoid redundant adjacent rows.

**Acceptance criteria**

- A task that remains active visibly transitions from yellow to its terminal color in place.
- A fast task appears only once in its terminal state.
- Failed and cancelled tasks are visually distinct from completed tasks.
- Task timestamps never contradict their position in the timeline.
- Opening the row still exposes full task output, errors, start time, and completion time when available.
- Automated tests cover running-to-completed, running-to-failed, cancellation, fast completion, and
  task disappearance from a snapshot.
