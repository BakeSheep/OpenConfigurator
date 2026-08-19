import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectNoPageOverflow, hashSearchParams, openDemo } from './support'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mc-lang')) localStorage.setItem('mc-lang', 'zh')
    if (!localStorage.getItem('mc-theme')) localStorage.setItem('mc-theme', 'light')
  })
})

async function expectQuery(page: Page, expected: Record<string, string | null>) {
  await expect.poll(() => {
    const params = hashSearchParams(page)
    return Object.fromEntries(Object.keys(expected).map((key) => [key, params.get(key)]))
  }).toEqual(expected)
}

async function expectSelectedTab(tablist: Locator, id: string, label: string) {
  const selected = tablist.getByRole('tab', { selected: true })
  await expect(selected).toHaveText(label)
  await expect(selected).toHaveAttribute('id', new RegExp(`-${id}$`))
  await expect(selected).toBeFocused()
}

test('Settings and Diagnostics section links preserve unrelated query state', async ({ page }) => {
  await openDemo(page, '/settings?section=sensors&tab=mag&mode=calibrate&probe=keep')
  const settingsNav = page.getByRole('navigation', { name: '飞行器设置子页面' })

  await settingsNav.getByRole('link', { name: '执行器' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('执行器')
  await expectQuery(page, { section: 'actuators', tab: null, mode: null, probe: 'keep' })

  await settingsNav.getByRole('link', { name: '机架' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('机架')
  await expectQuery(page, { section: null, tab: null, mode: null, probe: 'keep' })

  await openDemo(page, '/diagnostics?section=messages&tab=status&probe=keep')
  const diagnosticsNav = page.getByRole('navigation', { name: '调参与诊断子页面' })

  await diagnosticsNav.getByRole('link', { name: '实时波形' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('实时波形')
  await expectQuery(page, { section: 'waveforms', tab: null, probe: 'keep' })

  await diagnosticsNav.getByRole('link', { name: '完整参数' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('完整参数')
  await expectQuery(page, { section: null, tab: null, probe: 'keep' })
})

test('explicit default and invalid tab queries are canonicalized without losing unrelated state', async ({ page }) => {
  await openDemo(page, '/settings?section=sensors&tab=imu&probe=keep')
  const sensorTabs = page.getByRole('tablist', { name: '实时诊断' })
  await expect(sensorTabs.getByRole('tab', { selected: true })).toHaveText('IMU')
  await expectQuery(page, { section: 'sensors', tab: null, probe: 'keep' })

  await openDemo(page, '/diagnostics?section=messages&tab=retired-tab&probe=keep')
  const messageTabs = page.getByRole('tablist', { name: 'MAVLink 消息' })
  await expect(messageTabs.getByRole('tab', { selected: true })).toHaveText('消息')
  await expectQuery(page, { section: 'messages', tab: null, probe: 'keep' })
})

test('legacy EKF diagnostics deep link redirects to Other Settings EKF task', async ({ page }) => {
  await openDemo(page, '/diagnostics?section=ekf&probe=keep')

  await expect(page.locator('main h1')).toHaveText('飞行器设置')
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('其他设置')
  await expect(page.getByRole('tab', { name: 'EKF 融合', selected: true })).toBeVisible()
  await expectQuery(page, { section: 'other', tab: 'ekf', probe: 'keep' })
})

test('Sensor calibration has its own top navigation page and keeps busy sessions visible', async ({ page }) => {
  await openDemo(page, '/airframe/sensors')
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('传感器')
  await expect(page.getByRole('tablist', { name: '实时诊断' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '传感器校准', level: 3 })).toHaveCount(0)

  const airframeNav = page.getByRole('navigation', { name: '业务域页面' })
  await airframeNav.getByRole('link', { name: '校准', exact: true }).click()
  await expect(page).toHaveURL(/#\/airframe\/calibration$/)
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('校准')
  await expect(page.getByRole('tablist', { name: '实时诊断' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '传感器校准', level: 3 })).toBeVisible()

  await page.evaluate(async () => {
    const { useCalibrationStore } = await import('/src/web/stores/calibrationStore.ts')
    useCalibrationStore.getState().applySnapshot({
      sessionId: 'ui-history-calibration',
      seq: 1,
      ownerClientId: 'another-client',
      recoverUntil: null,
      requestId: 'ui-history-calibration-request',
      family: 'px4',
      kind: 'gyro',
      phase: 'running',
      verification: 'not_applicable',
      progress: 25,
      updatedAt: Date.now(),
      rebootRequired: false,
      cancelSupported: true,
    })
  })

  await expect(page.getByText('当前校准')).toBeVisible()

  await page.goBack()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('传感器')
  await expect(page.getByRole('tablist', { name: '实时诊断' })).toBeVisible()
})

test('Sensor calibration navigation and cards fit supported viewport widths', async ({ page }) => {
  for (const viewport of [
    { width: 360, height: 768 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport)
    await openDemo(page, '/airframe/calibration')
    const nav = page.getByRole('navigation', { name: '业务域页面' })
    await expect(nav.getByRole('link', { name: '校准', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: '传感器校准', level: 3 })).toBeVisible()
    await expectNoPageOverflow(page)
  }
})

test('PID autotune stays compact and exposes only the active flight task', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 768 })
  await openDemo(page, '/tuning/pid?tab=auto')
  await expect(page.getByRole('tab', { name: '自动', selected: true })).toBeVisible()

  await page.evaluate(async () => {
    const [{ useConnectionStore }, { useTelemetryStore }, { useParameterStore }, profiles] = await Promise.all([
      import('/src/web/stores/connectionStore.ts'),
      import('/src/web/stores/telemetryStore.ts'),
      import('/src/web/stores/parameterStore.ts'),
      import('/src/shared/vehicleProfiles.ts'),
    ])
    const identity = profiles.buildVehicleIdentity(12, 2)
    useConnectionStore.getState().setClientId(
      'ui-client', 5, '00000000-0000-4000-8000-000000000005',
    )
    useConnectionStore.getState().setController(
      'ui-client', Date.now() + 60_000, 5, '00000000-0000-4000-8000-000000000005',
    )
    useConnectionStore.setState({
      vehicleReady: true,
    })
    useTelemetryStore.getState().setVehicleIdentity(identity)
    useTelemetryStore.getState().setStatus({
      armed: true,
      mode: 'Position',
      modeId: 3,
      failsafe: 'unknown',
      systemStatus: 4,
      identity,
    })
    useParameterStore.getState().addParam({
      id: 'MC_ROLLRATE_P', value: 0.12, type: 9, param_count: 1, param_index: 0,
    })
  })

  const confirmation = page.getByRole('checkbox', { name: /Preflight|飞行前检查/ })
  await expect(confirmation).toBeVisible()
  await confirmation.check()
  await expect(page.getByRole('button', { name: '开始自动调参' })).toBeEnabled()
  await expectNoPageOverflow(page)

  await page.evaluate(async () => {
    const { useAutotuneStore } = await import('/src/web/stores/autotuneStore.ts')
    useAutotuneStore.getState().applySnapshot({
      sessionId: 'ui-autotune', seq: 1, requestId: 'ui-autotune-request',
      ownerClientId: 'ui-client', recoverUntil: null, family: 'px4', phase: 'tuning',
      verification: 'not_applicable', progress: 40, axis: 'pitch', initialModeId: 3,
      updatedAt: Date.now(), cancelSupported: false,
      baselineParameters: { MC_ROLLRATE_P: 0.12 },
    })
  })
  await expect(page.getByRole('heading', { name: '正在调参', level: 3 })).toBeVisible()
  await expect(page.getByText('需要中止时，请通过遥控器切换模式或降落。')).toBeVisible()
  await expectNoPageOverflow(page)
})

test('Terminal quick commands return keyboard focus to the terminal', async ({ page }) => {
  await openDemo(page, '/diagnostics?section=messages&tab=terminal')
  await page.evaluate(async () => {
    const { useShellStore } = await import('/src/web/stores/shellStore.ts')
    useShellStore.getState().setStatus(true)
  })

  const terminal = page.getByRole('textbox', { name: '飞控终端输入' })
  const help = page.getByRole('button', { name: /help.*列出当前固件可用命令/ })
  await help.click()

  await expect(terminal).toBeFocused()
  await expect(page.getByText('点击只写入当前 NSH 命令行，不会自动回车执行。')).toHaveCount(0)
})

const tabCases = [
  {
    name: 'PID tuning tasks',
    route: '/tuning/pid',
    tablistName: 'PID 调参方式',
    section: null,
    first: { id: 'manual', label: '手动' },
    second: { id: 'auto', label: '自动' },
    last: { id: 'auto', label: '自动' },
  },
  {
    name: 'Sensor diagnostics',
    route: '/settings?section=sensors',
    tablistName: '实时诊断',
    section: 'sensors',
    first: { id: 'imu', label: 'IMU' },
    second: { id: 'mag', label: '罗盘' },
    last: { id: 'rangefinder', label: '测距仪' },
  },
  {
    name: 'Motor tasks',
    route: '/settings?section=actuators',
    tablistName: '执行器输出与无桨测试',
    section: 'actuators',
    first: { id: 'mapping', label: '输出映射' },
    second: { id: 'test', label: '电机测试' },
    last: { id: 'test', label: '电机测试' },
  },
  {
    name: 'MAVLink message tasks',
    route: '/diagnostics?section=messages',
    tablistName: 'MAVLink 消息',
    section: 'messages',
    first: { id: 'messages', label: '消息' },
    second: { id: 'status', label: '状态' },
    last: { id: 'terminal', label: '终端' },
  },
  {
    name: 'Joystick tasks',
    route: '/settings?section=joystick',
    tablistName: '游戏手柄',
    section: 'joystick',
    first: { id: 'overview', label: '手柄状态' },
    second: { id: 'buttons', label: '按钮分配' },
    last: { id: 'buttons', label: '按钮分配' },
  },
] as const

for (const tabs of tabCases) {
  test(`${tabs.name} supports Arrow, Home and End while syncing ?tab=`, async ({ page }) => {
    await openDemo(page, tabs.route)
    const tablist = page.getByRole('tablist', { name: tabs.tablistName })
    const initial = tablist.getByRole('tab', { selected: true })
    await initial.focus()

    await initial.press('End')
    await expectSelectedTab(tablist, tabs.last.id, tabs.last.label)
    await expectQuery(page, { section: tabs.section, tab: tabs.last.id })

    await tablist.getByRole('tab', { selected: true }).press('Home')
    await expectSelectedTab(tablist, tabs.first.id, tabs.first.label)
    await expectQuery(page, { section: tabs.section, tab: null })

    await tablist.getByRole('tab', { selected: true }).press('ArrowRight')
    await expectSelectedTab(tablist, tabs.second.id, tabs.second.label)
    await expectQuery(page, { section: tabs.section, tab: tabs.second.id })

    await tablist.getByRole('tab', { selected: true }).press('ArrowLeft')
    await expectSelectedTab(tablist, tabs.first.id, tabs.first.label)
    await expectQuery(page, { section: tabs.section, tab: null })
  })
}
