import { test, expect, type Page } from '@playwright/test'
import { openDemo } from './support'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mc-lang')) localStorage.setItem('mc-lang', 'zh')
    if (!localStorage.getItem('mc-theme')) localStorage.setItem('mc-theme', 'light')
  })
})

test('armed demo disarm buttons send exactly one explicitly confirmed command', async ({ page }) => {
  await openDemo(page, '/flight')

  await page.evaluate(async () => {
    const [{ useConnectionStore }, { setDemoClientMessageInterceptor }, { startDemoMode }] = await Promise.all([
      import('/src/web/stores/connectionStore.ts'),
      import('/src/web/hooks/useWebSocket.ts'),
      import('/src/web/demo/demoMode.ts'),
    ])
    // Freeze the seeded demo state so its 500 ms read-only snapshot cannot
    // overwrite this controller-owned emergency-disarm fixture under load.
    startDemoMode()()
    const connection = useConnectionStore.getState()
    useConnectionStore.getState().setController(
      'demo-client',
      Date.now() + 60_000,
      connection.safetyEpoch,
      connection.safetyAuthorityId!,
    )
    const sentMessages: unknown[] = []
    ;(globalThis as typeof globalThis & { __uiSentClientMessages?: unknown[] }).__uiSentClientMessages = sentMessages
    setDemoClientMessageInterceptor((message) => {
      sentMessages.push(message)
      return true
    })
  })

  const flightArmControl = page.locator('.mc-flight-arm-safety')
  const flightDisarm = flightArmControl.getByRole('button', { name: '立即上锁', exact: true })
  await expect(flightDisarm).toBeVisible()
  await expect(flightDisarm).toBeEnabled()
  await expect(flightArmControl.getByRole('slider')).toHaveCount(0)
  await flightDisarm.click()

  const flightMessages = await page.evaluate(() => (
    (globalThis as typeof globalThis & { __uiSentClientMessages?: unknown[] }).__uiSentClientMessages ?? []
  ))
  expect(flightMessages).toEqual([{
    type: 'command',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [0, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'disarm',
  }])

  await page.evaluate(() => {
    const capture = (globalThis as typeof globalThis & { __uiSentClientMessages?: unknown[] }).__uiSentClientMessages
    if (capture) capture.length = 0
  })

  await page.locator('#mc-topbar-arm-trigger').click()
  const topbarArmMenu = page.locator('.mc-topbar-menu--arm')
  await expect(topbarArmMenu).toBeVisible()
  const topbarDisarm = topbarArmMenu.getByRole('button', { name: '立即上锁', exact: true })
  await expect(topbarDisarm).toBeVisible()
  await expect(topbarDisarm).toBeEnabled()
  await expect(topbarArmMenu.getByRole('slider')).toHaveCount(0)
  await topbarDisarm.click()

  const topbarMessages = await page.evaluate(() => (
    (globalThis as typeof globalThis & { __uiSentClientMessages?: unknown[] }).__uiSentClientMessages ?? []
  )) as Array<Record<string, unknown>>
  expect(topbarMessages).toHaveLength(1)
  expect(topbarMessages[0]).toMatchObject({
    type: 'command',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [0, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'disarm',
  })
  expect(topbarMessages[0].requestId).toEqual(expect.stringMatching(/^disarm-/))
})

test('closing StatusBar details restores focus to its summary', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Focus restoration is viewport-independent.')
  await openDemo(page, '/dashboard')

  const summary = page.locator('#mc-statusbar-summary')
  await summary.click()
  const details = page.locator('#mc-statusbar-details')
  await expect(details).toBeVisible()
  await details.getByRole('button', { name: '关闭', exact: true }).click()

  await expect(details).toBeHidden()
  await expect(summary).toBeFocused()
})

async function openLivePx4LogFixture(page: Page) {
  await page.routeWebSocket('ws://127.0.0.1:3000/ws', () => {})
  await page.goto('/#/dashboard')
  await expect(page.locator('main h1')).toHaveCount(1)

  // Seed the framework stores before mounting the log workspace. This keeps
  // the fixture at the public browser/UI boundary while avoiding hardware and
  // makes the component's target epoch start on the intended synthetic FC.
  await page.evaluate(async () => {
    const [{ useConnectionStore }, { useTelemetryStore }] = await Promise.all([
      import('/src/web/stores/connectionStore.ts'),
      import('/src/web/stores/telemetryStore.ts'),
    ])
    const connection = useConnectionStore.getState()
    connection.setClientId('ui-log-test')
    connection.setConnectionSnapshot({
      status: 'connected',
      transportOpen: true,
      vehicleReady: true,
      rawSessionActive: false,
      port: 'TEST',
      type: 'synthetic',
      baudRate: 57600,
    })
    connection.setController(null, null)
    connection.setTarget(1, 1)
    useTelemetryStore.getState().setVehicleIdentity({
      autopilotId: 12,
      vehicleTypeId: 2,
      family: 'px4',
      vehicleClass: 'copter',
    })
  })

  await page.evaluate(() => { window.location.hash = '/diagnostics?section=logs' })
  await expect(page.locator('.mc-explorer')).toBeVisible()

  await page.evaluate(async () => {
    const { useFileExplorerStore } = await import('/src/web/stores/fileExplorerStore.ts')
    const store = useFileExplorerStore.getState()
    const fileName = 'log_001.ulg'
    store.setListing(store.currentPath, [
      { name: fileName, kind: 'file', sizeBytes: 2048 },
      { name: 'log_002.ulg', kind: 'file', sizeBytes: 4096 },
    ])
    store.setSelection(new Set([fileName]), fileName)
  })
}

test('log rows use one roving tab stop and a keyboard context menu', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The keyboard contract is viewport-independent.')
  await openLivePx4LogFixture(page)

  const rows = page.locator('[data-explorer-row]')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('tabindex', '0')
  await expect(rows.nth(1)).toHaveAttribute('tabindex', '-1')

  await rows.nth(0).focus()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await expect(rows.nth(1)).toHaveAttribute('tabindex', '0')

  await page.keyboard.press('Shift+F10')
  const menu = page.getByRole('menu', { name: /log_002\.ulg/ })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(rows.nth(1)).toBeFocused()
})

test('changing the flight-controller target closes a prepared delete confirmation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The target-epoch safety check runs once.')
  await openLivePx4LogFixture(page)

  await page.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除飞控上的文件' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('checkbox').check()
  await expect(dialog.getByRole('button', { name: '永久删除' })).toBeEnabled()

  await page.evaluate(async () => {
    const { useConnectionStore } = await import('/src/web/stores/connectionStore.ts')
    useConnectionStore.getState().setTarget(2, 1)
  })
  await expect(dialog).toBeHidden()
})

test('360px log actions remain visible and keyboard reachable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The explicit 360px fixture runs once.')
  await page.setViewportSize({ width: 360, height: 768 })
  await openLivePx4LogFixture(page)

  const actions = page.locator('.mc-explorer__actions')
  const download = actions.getByRole('button', { name: '下载', exact: true })
  const analyze = actions.getByRole('button', { name: '下载并分析', exact: true })
  const remove = actions.getByRole('button', { name: '删除', exact: true })
  for (const button of [download, analyze, remove]) {
    await expect(button).toBeVisible()
    await expect(button).toBeEnabled()
  }

  const boxes = await actions.getByRole('button').evaluateAll((buttons) => buttons.map((button) => {
    const rect = button.getBoundingClientRect()
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
  }))
  for (const box of boxes) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(360)
    expect(box.bottom).toBeGreaterThan(box.top)
  }

  await download.focus()
  await expect(download).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(analyze).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(remove).toBeFocused()
})
