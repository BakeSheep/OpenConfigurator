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
    const [{ useConnectionStore }, { setDemoRuntimeCommandInterceptor }, { startDemoMode }] = await Promise.all([
      import('/src/web/stores/connectionStore.ts'),
      import('/src/web/hooks/useLocalRuntime.ts'),
      import('/src/web/demo/demoMode.ts'),
    ])
    // Freeze the seeded demo state so its 500 ms read-only snapshot cannot
    // overwrite this locally-owned emergency-disarm fixture under load.
    startDemoMode()()
    const connection = useConnectionStore.getState()
    connection.setConnectionSnapshot({
      status: 'connected',
      transportOpen: true,
      vehicleReady: true,
      rawSessionActive: false,
      safetyEpoch: connection.safetyEpoch,
      safetyAuthorityId: connection.safetyAuthorityId!,
      canControl: true,
    })
    const sentMessages: unknown[] = []
    ;(globalThis as typeof globalThis & { __uiSentRuntimeCommands?: unknown[] }).__uiSentRuntimeCommands = sentMessages
    setDemoRuntimeCommandInterceptor((message) => {
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
    (globalThis as typeof globalThis & { __uiSentRuntimeCommands?: unknown[] }).__uiSentRuntimeCommands ?? []
  ))
  expect(flightMessages).toEqual([{
    type: 'command',
    cmd: 'MAV_CMD_COMPONENT_ARM_DISARM',
    params: [0, 0, 0, 0, 0, 0, 0],
    safetyConfirmation: 'disarm',
  }])

  await page.evaluate(() => {
    const capture = (globalThis as typeof globalThis & { __uiSentRuntimeCommands?: unknown[] }).__uiSentRuntimeCommands
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
    (globalThis as typeof globalThis & { __uiSentRuntimeCommands?: unknown[] }).__uiSentRuntimeCommands ?? []
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

test('reboot stays beside connection and CPU plus average temperature stay visible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Desktop geometry verifies the full labelled controls.')
  await openDemo(page, '/dashboard')

  const actions = page.locator('.mc-topbar__actions')
  const reboot = actions.locator('#mc-topbar-reboot')
  const connection = actions.locator('.mc-topbar__connect')
  await expect(reboot).toBeVisible()
  await expect(reboot).toHaveAccessibleName('重启飞控')
  await expect(connection).toBeVisible()

  const [rebootBox, connectionBox] = await Promise.all([reboot.boundingBox(), connection.boundingBox()])
  expect(rebootBox).not.toBeNull()
  expect(connectionBox).not.toBeNull()
  expect(rebootBox!.x + rebootBox!.width).toBeLessThanOrEqual(connectionBox!.x + 1)

  await page.locator('#mc-topbar-tools-trigger').click()
  await expect(page.locator('#mc-topbar-tools-menu')).toBeVisible()
  await expect(page.locator('#mc-topbar-tools-menu').getByRole('button', { name: /重启/ })).toHaveCount(0)

  const metrics = page.locator('#mc-statusbar-summary .mc-statusbar__metrics')
  await expect(metrics).toBeVisible()
  await expect(metrics).toContainText('CPU')
  await expect(metrics).toContainText('均温')
  await expect(metrics).not.toContainText('—')
})

test('dashboard and flight keep their operational UI while disconnected', async ({ page }) => {
  await page.goto('/#/dashboard')
  await expect(page.locator('main h1')).toHaveCount(1)
  await expect(page.locator('main .mc-dashboard-primary-grid')).toBeVisible()
  await expect(page.locator('main')).not.toContainText('等待飞控连接')
  await expect(page.locator('main').getByRole('link', { name: /进入飞行操作/ })).toBeVisible()

  await page.goto('/#/flight')
  await expect(page.locator('main h1')).toHaveCount(1)
  await expect(page.locator('main .mc-flight-arm-safety')).toBeVisible()
  await expect(page.locator('main')).not.toContainText('等待飞控连接')
  await expect(page.locator('main').getByRole('button', { name: '起飞', exact: true })).toBeDisabled()
})

test('the connection menu hides a unique automatic target and asks only for an ambiguous target', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The target-selection interaction is viewport-independent.')
  await page.goto('/#/dashboard')
  await expect(page.locator('main h1')).toHaveCount(1)

  await page.evaluate(async () => {
    const [{ useConnectionStore }, { localRuntime }] = await Promise.all([
      import('/src/web/stores/connectionStore.ts'),
      import('/src/web/runtime/LocalRuntimeClient.ts'),
    ])
    await localRuntime.stop()
    const store = useConnectionStore.getState()
    const authority = '00000000-0000-4000-8000-000000000042'
    store.setClientId('ui-target-test', 7, authority)
    store.setConnectionSnapshot({
      status: 'connected',
      transportOpen: true,
      vehicleReady: true,
      rawSessionActive: false,
      port: '/dev/ttyACM0',
      type: 'serial',
      baudRate: 115200,
    })
    store.setController(null, null, 7, authority)
    store.setTarget(42, 1, 7, authority, 'automatic', null, [
      { systemId: 42, componentId: 1, autopilot: 12, type: 2 },
    ])
  })

  const connectionButton = page.locator('.mc-topbar__connect')
  await connectionButton.click()
  const menu = page.locator('.mc-topbar__arm-dropdown')
  await expect(menu).toContainText('/dev/ttyACM0')
  await expect(menu).not.toContainText('选择飞控')
  await expect(menu).not.toContainText('SYS 42 / COMP 1')

  await page.evaluate(async () => {
    const { useConnectionStore } = await import('/src/web/stores/connectionStore.ts')
    const authority = '00000000-0000-4000-8000-000000000042'
    const candidates = [
      { systemId: 42, componentId: 1, autopilot: 12, type: 2 },
      { systemId: 43, componentId: 1, autopilot: 3, type: 2 },
    ]
    useConnectionStore.getState().setTarget(42, 1, 8, authority, 'automatic', {
      reason: 'multiple_stable_targets',
      candidates,
    }, candidates)
  })

  await expect(menu).toContainText('选择飞控')
  await expect(menu.getByRole('button', { name: /SYS 42 \/ COMP 1/ })).toBeVisible()
  await expect(menu.getByRole('button', { name: /SYS 43 \/ COMP 1/ })).toBeVisible()

  await page.evaluate(async () => {
    const { useConnectionStore } = await import('/src/web/stores/connectionStore.ts')
    const authority = '00000000-0000-4000-8000-000000000042'
    const candidates = [
      { systemId: 42, componentId: 1, autopilot: 12, type: 2 },
      { systemId: 42, componentId: 2, autopilot: 3, type: 2 },
    ]
    useConnectionStore.getState().setTarget(42, 1, 9, authority, 'automatic', {
      reason: 'same_system_identity_conflict',
      candidates,
    }, candidates)
  })
  await expect(menu).toContainText('请断开重复设备或修改 MAVLink SYS ID')
  await expect(menu).not.toContainText('选择飞控')
  await expect(menu.getByRole('button', { name: /SYS \d+ \/ COMP \d+/ })).toHaveCount(0)
})

async function openLivePx4LogFixture(page: Page) {
  await page.goto('/#/dashboard')
  await expect(page.locator('main h1')).toHaveCount(1)

  // Seed the framework stores before mounting the log workspace. This keeps
  // the fixture at the public browser/UI boundary while avoiding hardware and
  // makes the component's target epoch start on the intended synthetic FC.
  await page.evaluate(async () => {
    const [{ useConnectionStore }, { useTelemetryStore }, { localRuntime }] = await Promise.all([
      import('/src/web/stores/connectionStore.ts'),
      import('/src/web/stores/telemetryStore.ts'),
      import('/src/web/runtime/LocalRuntimeClient.ts'),
    ])
    await localRuntime.stop()
    const connection = useConnectionStore.getState()
    const authorityId = crypto.randomUUID()
    connection.setConnectionSnapshot({
      status: 'connected',
      transportOpen: true,
      vehicleReady: true,
      rawSessionActive: false,
      port: 'TEST',
      type: 'synthetic',
      baudRate: 57600,
      safetyEpoch: 1,
      safetyAuthorityId: authorityId,
      canControl: true,
    })
    connection.setTarget(1, 1, 1, authorityId)
    useTelemetryStore.getState().setVehicleIdentity({
      autopilotId: 12,
      vehicleTypeId: 2,
      family: 'px4',
      vehicleClass: 'copter',
    })
  })

  await page.evaluate(() => { window.location.hash = '/flight-logs' })
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
