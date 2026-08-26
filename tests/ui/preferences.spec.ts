import { test, expect } from '@playwright/test'
import { expectNoBlockingAxeViolations, expectNoPageOverflow, openDemo } from './support'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mc-lang')) localStorage.setItem('mc-lang', 'zh')
    if (!localStorage.getItem('mc-theme')) localStorage.setItem('mc-theme', 'light')
  })
})

test('language and theme controls update the document and persist', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Preference behavior is viewport-independent.')
  test.setTimeout(90_000)
  await openDemo(page, '/dashboard')
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-lang', 'zh')
  await expect(html).toHaveAttribute('lang', 'zh-CN')
  await expect(html).toHaveAttribute('data-theme', 'light')

  const toolsTrigger = page.locator('#mc-topbar-tools-trigger')
  await toolsTrigger.click()
  await page.getByRole('menuitem', { name: 'Switch to English' }).click()
  await expect(toolsTrigger).toBeFocused()
  await expect(html).toHaveAttribute('data-lang', 'en')
  await expect(html).toHaveAttribute('lang', 'en')
  await expect(page.locator('main h1')).toHaveText('Overview')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mc-lang'))).toBe('en')

  await toolsTrigger.click()
  await page.getByRole('menuitem', { name: 'Switch to Dark Theme' }).click()
  await expect(toolsTrigger).toBeFocused()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mc-theme'))).toBe('dark')
  await expectNoBlockingAxeViolations(page)

  await page.reload()
  await expect(page.locator('main h1')).toHaveText('Overview')
  await expect(html).toHaveAttribute('data-lang', 'en')
  await expect(html).toHaveAttribute('data-theme', 'dark')

  for (const route of [
    '/dashboard',
    '/flight',
    '/airframe/sensors',
    '/propulsion',
    '/propulsion/esc',
    '/control-input',
    '/airframe/ports',
    '/tuning/pid',
    '/tuning/ekf',
    '/flight-data',
    '/flight-logs',
    '/flight-logs/analysis',
  ]) {
    await test.step(`dark English ${route}`, async () => {
      await openDemo(page, route)
      await expect(html).toHaveAttribute('data-lang', 'en')
      await expect(html).toHaveAttribute('data-theme', 'dark')
      await expectNoPageOverflow(page)
      await expectNoBlockingAxeViolations(page, { soft: true })
    })
  }
})
