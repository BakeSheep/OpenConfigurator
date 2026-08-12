import { test, expect, type Locator, type Page } from '@playwright/test'
import { hashSearchParams, openDemo } from './support'

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

test('Sensor busy calibration switches tasks without trapping browser history', async ({ page }) => {
  await openDemo(page, '/dashboard')
  await page.evaluate(() => { window.location.hash = '/settings?section=sensors' })
  await expect(page.locator('.mc-section-frame__header h2')).toHaveText('传感器')
  const historyAtSensor = await page.evaluate(() => window.history.length)

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

  await expectQuery(page, { section: 'sensors', mode: 'calibrate' })
  await expect(page.getByRole('tab', { name: '校准', selected: true })).toBeVisible()
  expect(await page.evaluate(() => window.history.length)).toBe(historyAtSensor)

  await page.goBack()
  await expect(page.locator('main h1')).toHaveText('总览')
})

const tabCases = [
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
