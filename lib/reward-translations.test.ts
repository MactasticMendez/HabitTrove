import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createTranslator } from 'next-intl'

for (const locale of ['ca', 'de', 'en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh']) {
  test(`remaining reward uses contain exactly one count in ${locale}`, () => {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'))
    const translate = createTranslator({ locale, messages, namespace: 'WishlistItem' })
    for (const count of [1, 2]) {
      const label = translate(count === 1 ? 'usesLeftSingular' : 'usesLeftPlural', { count })
      expect(label.match(/\d+/g)).toEqual([String(count)])
      expect(label).not.toContain('{count}')
    }
  })
}
