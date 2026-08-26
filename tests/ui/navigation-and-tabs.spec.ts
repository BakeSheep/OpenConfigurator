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

test('domain links preserve unrelated query state and clear task-local state', async ({ page }) => {
  await openDemo(page, '/airframe/sensors?tab=mag&mode=calibrate&probe=keep')
  const airframeNav = page.getByRole('navigation', { name: '业务域页面' })

  await airframeNav.getByRole('link', { name: '电源' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('电源')
  await expect(page).toHaveURL(/#\/airframe\/power\?probe=keep$/)
  await expectQuery(page, { tab: null, mode: null, probe: 'keep' })

  await airframeNav.getByRole('link', { name: '机架' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('机架')
  await expectQuery(page, { tab: null, mode: null, probe: 'keep' })

  await openDemo(page, '/flight-data/status?tab=status&probe=keep')
  const dataNav = page.getByRole('navigation', { name: '业务域页面' })

  await dataNav.getByRole('link', { name: '实时波形' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('实时波形')
  await expectQuery(page, { tab: null, probe: 'keep' })

  await dataNav.getByRole('link', { name: 'MAVLink 消息' }).click()
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('MAVLink 消息')
  await expectQuery(page, { tab: null, probe: 'keep' })
})

test('explicit default and invalid tab queries are canonicalized without losing unrelated state', async ({ page }) => {
  await openDemo(page, '/airframe/sensors?tab=imu&probe=keep')
  const sensorTabs = page.getByRole('tablist', { name: '实时诊断' })
  await expect(sensorTabs.getByRole('tab', { selected: true })).toHaveText('IMU')
  await expectQuery(page, { tab: null, probe: 'keep' })

  await openDemo(page, '/control-input/joystick?tab=retired-tab&probe=keep')
  const joystickTabs = page.getByRole('tablist', { name: '游戏手柄' })
  await expect(joystickTabs.getByRole('tab', { selected: true })).toHaveText('手柄状态')
  await expectQuery(page, { tab: null, probe: 'keep' })
})

test('legacy EKF diagnostics deep link redirects to Other Settings EKF task', async ({ page }) => {
  await openDemo(page, '/diagnostics?section=ekf&probe=keep')

  await expect(page.locator('main h1')).toHaveText('调参与状态')
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('EKF')
  await expect(page).toHaveURL(/#\/tuning\/ekf\?probe=keep$/)
  await expectQuery(page, { tab: null, probe: 'keep' })
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

test('Terminal quick commands return keyboard focus to the terminal', async ({ page }) => {
  await openDemo(page, '/flight-data/terminal?tab=terminal')
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
    name: 'Sensor diagnostics',
    route: '/airframe/sensors',
    tablistName: '实时诊断',
    first: { id: 'imu', label: 'IMU' },
    second: { id: 'mag', label: '罗盘' },
    last: { id: 'rangefinder', label: '测距仪' },
  },
  {
    name: 'Joystick tasks',
    route: '/control-input/joystick',
    tablistName: '游戏手柄',
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
    await expectQuery(page, { tab: tabs.last.id })

    await tablist.getByRole('tab', { selected: true }).press('Home')
    await expectSelectedTab(tablist, tabs.first.id, tabs.first.label)
    await expectQuery(page, { tab: null })

    await tablist.getByRole('tab', { selected: true }).press('ArrowRight')
    await expectSelectedTab(tablist, tabs.second.id, tabs.second.label)
    await expectQuery(page, { tab: tabs.second.id })

    await tablist.getByRole('tab', { selected: true }).press('ArrowLeft')
    await expectSelectedTab(tablist, tabs.first.id, tabs.first.label)
    await expectQuery(page, { tab: null })
  })
}
