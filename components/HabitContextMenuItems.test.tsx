import { expect, test } from 'bun:test'

test('reschedule controls explain unsupported cycles and pending approval without changing history', async () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { NextIntlClientProvider } from 'next-intl';
    import { DateTime } from 'luxon';
    import messages from './messages/en.json';
    import { getDefaultSettings } from './lib/types';
    let entries = [], saved = [];
    const state = { settings: { ...getDefaultSettings(), system: { ...getDefaultSettings().system, timezone: 'UTC' } }, user: { id: 'actor', isAdmin: true } };
    mock.module('jotai', () => ({ useAtom: atom => [state[atom], () => {}] }));
    mock.module('@/lib/atoms', () => ({ settingsAtom: 'settings', currentUserAtom: 'user', pomodoroAtom: 'pomo' }));
    mock.module('@/hooks/useHabits', () => ({ useHabits: () => ({ saveHabit: value => saved.push(value), archiveHabit() {}, unarchiveHabit() {} }) }));
    const Item = props => { entries.push(props); return React.createElement('button', { disabled: props.disabled, 'aria-describedby': props['aria-describedby'] }, props.children); };
    const Separator = () => null;
    mock.module('@/components/ui/dropdown-menu', () => ({ DropdownMenuItem: Item, DropdownMenuSeparator: Separator }));
    mock.module('@/components/ui/context-menu', () => ({ ContextMenuItem: Item, ContextMenuSeparator: Separator }));
    const { HabitContextMenuItems } = await import('./components/HabitContextMenuItems');
    const base = { id: 'task', name: 'Example task', description: '', coinReward: 1, completions: [], isTask: true, frequency: DateTime.now().toUTC().minus({ days: 2 }).toISO() };
    const label = entry => renderToStaticMarkup(React.createElement('span', null, entry.children)).replace(/<[^>]*>/g, '');
    function render(habit, context) {
      entries = []; saved = [];
      const html = renderToStaticMarkup(React.createElement(NextIntlClientProvider, {locale: 'en', timeZone: 'UTC', messages}, React.createElement(HabitContextMenuItems, { habit, context, onEditRequest() {}, onDeleteRequest() {} })));
      const moves = entries.filter(entry => /Move to (Today|Tomorrow)/.test(label(entry)));
      return { html, moves };
    }
    for (const context of ['habit-item', 'daily-overview']) {
      const relative = { ...base, schedule: { type: 'afterCompletion', interval: 1, unit: 'months', startsOn: '2000-01-01' } };
      const { html, moves } = render(relative, context);
      assert(moves.length > 0);
      assert(moves.every(entry => entry.disabled === true), 'completion-relative moves must be disabled');
      assert(moves.every(entry => entry['aria-describedby']), 'disabled moves need an explanation');
      assert(html.includes(messages.HabitContextMenuItems.rescheduleAfterCompletionHelp));
      assert(entries.find(entry => !entry.disabled)?.['aria-describedby'], 'first keyboard-reachable action must announce the move explanation');
      assert.equal(saved.length, 0);
      const pending = { ...base, completions: ['2026-01-01T12:00:00Z'], completionRecords: [{ id: 'pending', actorId: 'actor', approval: 'pending' }] };
      const waiting = render(pending, context);
      assert(waiting.moves.every(entry => entry.disabled === true), 'pending approval must lock moves');
      assert(waiting.html.includes(messages.HabitContextMenuItems.reschedulePendingHelp));
      for (const task of [base, { ...base, taskRepeat: 'daily' }]) {
        const supported = render(task, context);
        const tomorrow = supported.moves.find(entry => label(entry).includes('Tomorrow'));
        assert(tomorrow && !tomorrow.disabled, 'conventional task move stays available');
        tomorrow.onClick();
        assert.equal(saved.length, 1);
        assert.equal(DateTime.fromISO(saved[0].frequency).toUTC().toISODate(), DateTime.now().toUTC().plus({days:1}).toISODate());
        assert.deepEqual(saved[0].completions, task.completions);
      }
    }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(code).toBe(0)
})
