# Scheduling, any-time actions and family oversight

Existing frequency strings and completion history remain valid. Guided calendar schedules keep using RRule for habits and task recurrence fields for tasks. Optional structured schedules add intervals measured from an approved completion and any-time actions.

- Calendar controls cover every N days/weeks/months/years, chosen weekdays, month dates/nth weekdays, start dates and optional end dates.
- After-completion schedules become due at the initial start date, then at the configured interval after the last approved target-reaching day. Pending/rejected submissions do not move the next due date. An overdue interval remains actionable; it does not create one debt per missed day.
- Any-time habits belong to one member. The creator chooses member, manager or both recording permissions. Each approved action rewards that member; actor and beneficiary are recorded separately. Request IDs prevent retried submissions from creating duplicate rewards. Each action can be undone by its recorder under the existing recovery rules.
- Administrators and designated managers receive a Family page scoped to the members they manage. It shows balances, status, due/completed counts, pending approvals, habits/tasks and rewards. Existing edit components are reused. Family reward redemption uses the selected member's balance and records the acting manager. A manager selecting themselves retains their ordinary account permissions.

Validation covers legacy schedules, custom calendar intervals, month ends, DST, completion-relative dates, pending approval, any-time replay and concurrent submissions, beneficiary authorization, manager/member/both policy, undo, family data isolation and reward limits. Rendered QA covers desktop/mobile forms and the Family page with axe checks.
