import { expect, test, type Page } from '@playwright/test'
import { expectNoBlockingAxeViolations, expectNoPageOverflow, openDemo } from './support'

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

test('domain workspaces stack below a visible horizontal navigator at compact widths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This regression sets the two boundary viewports explicitly.')

  for (const width of [1024, 1180]) {
    await page.setViewportSize({ width, height: 768 })
    await openDemo(page, '/flight-logs/analysis')

    const nav = page.getByRole('navigation', { name: '业务域页面' })
    const active = nav.getByRole('link', { name: '日志分析' })
    const frame = page.locator('.mc-section-frame')
    await expect(active).toBeVisible()
    await expect(frame).toBeVisible()

    const geometry = await page.locator('.mc-domain-nav').evaluate((navElement) => {
      const activeElement = navElement.querySelector<HTMLElement>('[data-active="true"]')!
      const frameElement = document.querySelector<HTMLElement>('.mc-section-frame')!
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

test('GPS diagnostics reuse shared card and tab styling at supported widths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This regression sets all supported widths explicitly.')

  for (const viewport of [
    { width: 360, height: 768 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await openDemo(page, '/airframe/sensors?tab=gps')

    const metrics = page.locator('.mc-gps-metric')
    const instanceTab = page.locator('.mc-gps-config__tabs .mc-tab[data-active="true"]')
    const sensorTab = page.locator('.mc-sensor-diagnostics > .mc-tabbar .mc-tab[data-active="true"]')
    await expect(metrics).toHaveCount(4)
    await expect(instanceTab).toHaveCount(1)

    const presentation = await page.evaluate(() => {
      const metric = document.querySelector<HTMLElement>('.mc-gps-metric')!
      const card = document.querySelector<HTMLElement>('.mc-gps-dop')!
      const instance = document.querySelector<HTMLElement>('.mc-gps-config__tabs .mc-tab[data-active="true"]')!
      const sensor = document.querySelector<HTMLElement>('.mc-sensor-diagnostics > .mc-tabbar .mc-tab[data-active="true"]')!
      const metricStyle = getComputedStyle(metric)
      const cardStyle = getComputedStyle(card)
      const metricBefore = getComputedStyle(metric, '::before')
      const instanceStyle = getComputedStyle(instance)
      const sensorStyle = getComputedStyle(sensor)
      return {
        metricUsesCard: metric.classList.contains('mc-card'),
        metricBeforeContent: metricBefore.content,
        metricBackground: metricStyle.backgroundColor,
        metricRadius: metricStyle.borderRadius,
        cardBackground: cardStyle.backgroundColor,
        cardRadius: cardStyle.borderRadius,
        instanceRadius: instanceStyle.borderRadius,
        instanceBackground: instanceStyle.backgroundColor,
        sensorRadius: sensorStyle.borderRadius,
        sensorBackground: sensorStyle.backgroundColor,
      }
    })

    expect(presentation.metricUsesCard).toBe(true)
    expect(presentation.metricBeforeContent).toBe('none')
    expect(presentation.metricBackground).toBe(presentation.cardBackground)
    expect(presentation.metricRadius).toBe(presentation.cardRadius)
    expect(presentation.instanceRadius).toBe(presentation.sensorRadius)
    expect(presentation.instanceBackground).toBe(presentation.sensorBackground)
    await expectNoPageOverflow(page)
  }

  await page.evaluate(() => {
    localStorage.setItem('mc-lang', 'en')
    localStorage.setItem('mc-theme', 'dark')
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Airframe', level: 1 })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'GPS', exact: true, selected: true })).toBeVisible()
  await expectNoPageOverflow(page)
  await expectNoBlockingAxeViolations(page)
})

test('reviewed GPS, ESC, and control-input surfaces use the shared hierarchy', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'This regression sets the supported widths explicitly.')

  const expectedControlInputLinks = ['遥控器', '遥控器配置', '游戏手柄', '手柄配置']
  for (const viewport of [
    { width: 360, height: 768 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await openDemo(page, '/control-input/joystick')
    const domainNav = page.getByRole('navigation', { name: '业务域页面' })
    await expect(domainNav.getByRole('link')).toHaveText(expectedControlInputLinks)
    await expect(page.locator('main').getByRole('tablist')).toHaveCount(0)
    await expectNoPageOverflow(page)
  }

  await page.setViewportSize({ width: 1292, height: 1047 })
  await page.getByRole('link', { name: '手柄配置', exact: true }).click()
  await expect(page).toHaveURL(/#\/control-input\/joystick-config$/)
  await expect(page.getByRole('heading', { name: '按钮分配', level: 3 })).toBeVisible()
  await expect(page.locator('main').getByRole('tablist')).toHaveCount(0)

  await openDemo(page, '/control-input/joystick?tab=buttons')
  await expect(page).toHaveURL(/#\/control-input\/joystick-config$/)
  await openDemo(page, '/control-input/flight-modes')
  await expect(page).toHaveURL(/#\/control-input\/receiver-config$/)

  await openDemo(page, '/propulsion/esc')
  const connectCard = page.locator('.mc-esc-connect')
  const modePicker = page.locator('.mc-esc-mode-picker')
  await expect(connectCard.locator('.mc-esc-connect__header')).toHaveCount(0)
  await expect(modePicker).toContainText('ArduPilot')
  const escGeometry = await Promise.all([connectCard.boundingBox(), modePicker.boundingBox()])
  expect(escGeometry[0]).not.toBeNull()
  expect(escGeometry[1]).not.toBeNull()
  expect(escGeometry[1]!.y - escGeometry[0]!.y).toBeLessThanOrEqual(24)
  await expectNoPageOverflow(page)

  await openDemo(page, '/dashboard')
  await page.getByRole('button', { name: /21 SAT/ }).click()
  const gpsTiles = page.locator('.mc-topbar-menu--gps > dl > div')
  await expect(gpsTiles).toHaveCount(11)
  const gpsPresentation = await gpsTiles.first().evaluate((tile) => {
    const style = getComputedStyle(tile)
    const listStyle = getComputedStyle(tile.parentElement!)
    return { radius: style.borderRadius, background: style.backgroundColor, gap: listStyle.gap }
  })
  expect(Number.parseFloat(gpsPresentation.radius)).toBeGreaterThan(0)
  expect(gpsPresentation.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(gpsPresentation.gap).toBe('8px')
  await expectNoPageOverflow(page)
  await expectNoBlockingAxeViolations(page)

  await page.evaluate(() => {
    localStorage.setItem('mc-lang', 'en')
    localStorage.setItem('mc-theme', 'dark')
  })
  await page.reload()
  await page.getByRole('button', { name: /21 SAT/ }).click()
  await expect(page.getByText('GPS Details', { exact: true })).toBeVisible()
  await expectNoPageOverflow(page)
  await openDemo(page, '/control-input/joystick')
  await expect(page.getByRole('navigation', { name: 'Business domain pages' }).getByRole('link')).toHaveText([
    'Receiver', 'Receiver Configuration', 'Joystick', 'Gamepad Configuration',
  ])
  await expect(page.locator('main').getByRole('tablist')).toHaveCount(0)
  await expectNoPageOverflow(page)
  await expectNoBlockingAxeViolations(page)
})
