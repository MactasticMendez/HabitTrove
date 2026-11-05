import { expect, test } from 'bun:test'

test('redemption refreshes reward limits and revision before the next edit', async () => {
  // Isolate action mocks from other tests that exercise the real server actions.
  const script = `
    import assert from 'node:assert/strict';
    import { mock } from 'bun:test';
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { Provider, createStore } from 'jotai';
    import { NextIntlClientProvider } from 'next-intl';
    import messages from './messages/en.json';
    import { wishlistAtom, coinsAtom, currentUserIdAtom, usersAtom } from './lib/atoms';

    let authoritative;
    mock.module('@/app/actions/data', () => ({
      removeCoins: async () => {
        authoritative = {
          revision: 8,
          items: [{ ...authoritative.items[0], targetCompletions: undefined, archived: true }],
        };
        return { balance: 12, transactions: [], revision: 4 };
      },
      loadWishlistData: async () => structuredClone(authoritative),
      saveWishlistItems: async data => {
        assert.equal(data.revision, authoritative.revision, 'the next edit must use the post-redemption revision');
        authoritative = { ...data, revision: 9 };
        return structuredClone(authoritative);
      },
    }));
    mock.module('./hooks/useCoins', () => ({ useCoins: () => ({ balance: 20 }) }));
    const { useWishlist } = await import('./hooks/useWishlist');
    const store = createStore();
    const reward = { id: 'reward', name: 'Treat', description: '', coinCost: 8, targetCompletions: 1, userIds: ['member'] };
    authoritative = { items: [reward], revision: 7 };
    store.set(wishlistAtom, structuredClone(authoritative));
    store.set(usersAtom, { users: [{ id: 'member', username: 'Member', isAdmin: true }] });
    store.set(currentUserIdAtom, 'member');
    let hook;
    function Harness() { hook = useWishlist(); return null; }
    function render() {
      renderToStaticMarkup(React.createElement(Provider, { store },
        React.createElement(NextIntlClientProvider, { locale: 'en', timeZone: 'UTC', messages },
          React.createElement(Harness))));
    }
    render();
    assert.equal(await hook.redeemWishlistItem(reward), true);
    assert.equal(store.get(coinsAtom).balance, 12);
    assert.equal(store.get(wishlistAtom).items[0].archived, true);
    render();
    await hook.editWishlistItem({ ...hook.wishlistItems[0], name: 'Edited after redemption' });
    assert.equal(store.get(wishlistAtom).revision, 9);
    assert.equal(store.get(wishlistAtom).items[0].name, 'Edited after redemption');
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
})
