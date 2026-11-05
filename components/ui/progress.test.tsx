import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Progress } from './progress'

test('assistive technology receives the named progress value and bounds', () => {
  const html = renderToStaticMarkup(<Progress aria-label="Reward savings" value={60} />)
  expect(html).toContain('aria-label="Reward savings"')
  expect(html).toContain('aria-valuenow="60"')
  expect(html).toContain('aria-valuemin="0"')
  expect(html).toContain('aria-valuemax="100"')
})
