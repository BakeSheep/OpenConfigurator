import { expect, test, type Page } from '@playwright/test'
import { openDemo } from './support'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mc-lang')) localStorage.setItem('mc-lang', 'zh')
    if (!localStorage.getItem('mc-theme')) localStorage.setItem('mc-theme', 'light')
  })
})

async function focusLastTabStopInMain(page: Page) {
  return page.locator('main').evaluate((main) => {
    const selector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',')
    const tabStops = Array.from(main.querySelectorAll<HTMLElement>(selector)).filter((element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return element.tabIndex >= 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0
    })
    const last = tabStops.at(-1)
    last?.focus()
    return { count: tabStops.length, focused: document.activeElement === last }
  })
}

test('top-level navigation resets a long workspace and focuses the new page heading', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The route-level scroll and focus contract is viewport-independent.')
  await page.setViewportSize({ width: 1280, height: 480 })

  // Load the destination once so this regression isolates route focus/scroll
  // behavior from lazy-module loading time.
  await openDemo(page, '/flight')
  const desktopNav = page.locator('.mc-sidebar--desktop')
  await desktopNav.getByRole('link', { name: '总览' }).click()
  await expect(page.locator('main h1')).toHaveText('总览')

  const main = page.locator('main.mc-app-shell__main')
  await page.locator('.mc-workspace-frame').evaluate((workspace) => {
    const element = workspace as HTMLElement
    element.style.minHeight = '1600px'
  })
  await main.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: 'auto' }))
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

  await desktopNav.getByRole('link', { name: '飞行操作' }).click()
  const heading = page.locator('main h1')
  await expect(heading).toHaveText('飞行操作')
  await expect(heading).toBeFocused()
  await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBe(0)
})

test('responsive sidebars keep the visible navigation on the correct side of main in DOM and Tab order', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This test sets both responsive viewports explicitly.')

  await page.setViewportSize({ width: 360, height: 768 })
  await openDemo(page, '/dashboard')
  const main = page.locator('main.mc-app-shell__main')
  const desktopSidebar = page.locator('.mc-sidebar--desktop')
  const mobileSidebar = page.locator('.mc-sidebar--mobile')
  await expect(desktopSidebar).toBeHidden()
  await expect(mobileSidebar).toBeVisible()

  const mobileOrder = await page.locator('.mc-app-shell__body').evaluate((body) => {
    const children = Array.from(body.children)
    return {
      main: children.indexOf(body.querySelector(':scope > main')!),
      mobile: children.indexOf(body.querySelector(':scope > .mc-sidebar--mobile')!),
    }
  })
  expect(mobileOrder.main).toBeGreaterThanOrEqual(0)
  expect(mobileOrder.mobile).toBeGreaterThan(mobileOrder.main)

  const lastMainTabStop = await focusLastTabStopInMain(page)
  expect(lastMainTabStop.count).toBeGreaterThan(0)
  expect(lastMainTabStop.focused).toBe(true)
  await page.keyboard.press('Tab')
  await expect(mobileSidebar.getByRole('link').first()).toBeFocused()

  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(desktopSidebar).toBeVisible()
  await expect(mobileSidebar).toBeHidden()
  const desktopOrder = await page.locator('.mc-app-shell__body').evaluate((body) => {
    const children = Array.from(body.children)
    return {
      desktop: children.indexOf(body.querySelector(':scope > .mc-sidebar--desktop')!),
      main: children.indexOf(body.querySelector(':scope > main')!),
    }
  })
  expect(desktopOrder.desktop).toBeGreaterThanOrEqual(0)
  expect(desktopOrder.main).toBeGreaterThan(desktopOrder.desktop)

  await desktopSidebar.getByRole('link').last().focus()
  await page.keyboard.press('Tab')
  await expect.poll(() => main.evaluate((element) => element.contains(document.activeElement))).toBe(true)
})

test('saved preset delete action is visible without hover and keyboard accessible at 360px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The mobile preset interaction runs once.')
  await page.setViewportSize({ width: 360, height: 768 })
  await page.addInitScript(() => {
    localStorage.setItem('oc-connection-presets', JSON.stringify([{
      id: 'ui-preset',
      name: '测试飞控',
      type: 'serial',
      port: 'COM42',
      baudRate: 115200,
    }]))
  })
  await page.routeWebSocket('ws://127.0.0.1:3000/ws', () => {})
  await page.goto('/#/dashboard')
  await expect(page.locator('main h1')).toHaveCount(1)

  await page.locator('button.mc-topbar__connect').click()
  const deletePreset = page.getByRole('button', { name: '删除 测试飞控', exact: true })
  await expect(deletePreset).toBeVisible()
  await expect(deletePreset).toHaveAccessibleName('删除 测试飞控')

  await page.mouse.move(0, 767)
  const presentation = await deletePreset.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      hovered: element.matches(':hover'),
      opacity: Number.parseFloat(window.getComputedStyle(element).opacity),
      width: rect.width,
      height: rect.height,
    }
  })
  expect(presentation.hovered).toBe(false)
  expect(presentation.opacity).toBeGreaterThan(0)
  expect(presentation.width).toBeGreaterThanOrEqual(24)
  expect(presentation.height).toBeGreaterThanOrEqual(24)

  await deletePreset.locator('..').getByRole('button').first().focus()
  await page.keyboard.press('Tab')
  await expect(deletePreset).toBeFocused()
  await expect(deletePreset).toBeVisible()
})

test('section workspaces stack below a visible horizontal navigator at compact widths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This regression sets the two boundary viewports explicitly.')

  for (const width of [1024, 1180]) {
    await page.setViewportSize({ width, height: 768 })
    await openDemo(page, '/diagnostics?section=log-analysis')

    const nav = page.getByRole('navigation', { name: '调参与诊断子页面' })
    const active = nav.getByRole('link', { name: '日志分析' })
    const frame = page.locator('.mc-section-frame')
    await expect(active).toBeVisible()
    await expect(frame).toBeVisible()

    const geometry = await page.locator('.mc-section-layout').evaluate((layout) => {
      const navElement = layout.querySelector<HTMLElement>('.mc-section-nav')!
      const activeElement = navElement.querySelector<HTMLElement>('[data-active="true"]')!
      const frameElement = layout.querySelector<HTMLElement>('.mc-section-frame')!
      const navRect = navElement.getBoundingClientRect()
      const activeRect = activeElement.getBoundingClientRect()
      const frameRect = frameElement.getBoundingClientRect()
      return {
        navBottom: navRect.bottom,
        frameTop: frameRect.top,
        frameLeft: frameRect.left,
        frameRight: frameRect.right,
        viewportWidth: window.innerWidth,
        activeVisible: activeRect.left >= navRect.left - 1 && activeRect.right <= navRect.right + 1,
      }
    })

    expect(geometry.frameTop).toBeGreaterThanOrEqual(geometry.navBottom)
    expect(geometry.frameLeft).toBeGreaterThanOrEqual(0)
    expect(geometry.frameRight).toBeLessThanOrEqual(geometry.viewportWidth)
    expect(geometry.activeVisible).toBe(true)
  }
})
