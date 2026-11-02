import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import MobileNavDisplay from './MobileNavDisplay'

test('mobile navigation renders when browser globals are unavailable', () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined })
  try {
    expect(() => renderToString(<MobileNavDisplay navItems={[]} />)).not.toThrow()
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  }
})
