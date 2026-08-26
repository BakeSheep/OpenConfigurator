import { test, expect } from '@playwright/test'
import {
  expectNoBlockingAxeViolations,
  expectNoPageOverflow,
  expectSharedWorkspaceLayout,
  openDemo,
} from './support'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mc-lang')) localStorage.setItem('mc-lang', 'zh')
    if (!localStorage.getItem('mc-theme')) localStorage.setItem('mc-theme', 'light')
  })
})

const workspaces = [
  { name: 'dashboard', route: '/dashboard', heading: '总览' },
  { name: 'flight', route: '/flight', heading: '飞行操作' },
  { name: 'airframe', route: '/airframe', heading: '机体配置', section: '机架' },
  { name: 'airframe sensors', route: '/airframe/sensors', heading: '机体配置', section: '传感器' },
  { name: 'airframe calibration', route: '/airframe/calibration', heading: '机体配置', section: '校准' },
  { name: 'airframe power', route: '/airframe/power', heading: '机体配置', section: '电源' },
  { name: 'airframe safety', route: '/airframe/safety', heading: '机体配置', section: '安全' },
  { name: 'airframe ports', route: '/airframe/ports', heading: '机体配置', section: '端口' },
  { name: 'propulsion', route: '/propulsion', heading: '动力与输出', section: '输出映射' },
  { name: 'propulsion test', route: '/propulsion/test', heading: '动力与输出', section: '电机测试' },
  { name: 'propulsion esc', route: '/propulsion/esc', heading: '动力与输出', section: '电调' },
  { name: 'control input', route: '/control-input', heading: '遥控输入', section: '遥控器' },
  { name: 'receiver config', route: '/control-input/receiver-config', heading: '遥控输入', section: '遥控器配置' },
  { name: 'joystick', route: '/control-input/joystick', heading: '遥控输入', section: '游戏手柄' },
  { name: 'joystick config', route: '/control-input/joystick-config', heading: '遥控输入', section: '手柄配置' },
  { name: 'tuning', route: '/tuning', heading: '调参与状态', section: '完整参数' },
  { name: 'tuning pid', route: '/tuning/pid', heading: '调参与状态', section: 'PID 调参' },
  { name: 'tuning ekf', route: '/tuning/ekf', heading: '调参与状态', section: 'EKF' },
  { name: 'flight data', route: '/flight-data', heading: '日志与链路', section: 'MAVLink 消息' },
  { name: 'flight data status', route: '/flight-data/status', heading: '日志与链路', section: '状态' },
  { name: 'flight data terminal', route: '/flight-data/terminal', heading: '日志与链路', section: '终端' },
  { name: 'flight data waveforms', route: '/flight-data/waveforms', heading: '日志与链路', section: '实时波形' },
  { name: 'flight logs', route: '/flight-logs', heading: '日志与分析', section: '飞行日志' },
  { name: 'log analysis', route: '/flight-logs/analysis', heading: '日志与分析', section: '日志分析' },
] as const

for (const workspace of workspaces) {
  test(`${workspace.name} uses the shared hierarchy without page overflow`, async ({ page }) => {
    await openDemo(page, workspace.route)

    const workspaceHeading = page.locator('main h1')
    await expect(workspaceHeading).toHaveText(workspace.heading)
    if ('section' in workspace) {
      const sectionHeading = page.locator('.mc-section-frame__header h2')
      await expect(sectionHeading).toHaveCount(1)
      await expect(sectionHeading).toHaveText(workspace.section)
      // Domain workspaces expose the task navigation above the content frame.
      const domainNav = page.getByRole('navigation', { name: '业务域页面' })
      await expect(domainNav.locator('[aria-current="page"]')).toHaveText(workspace.section)
    }

    await expectSharedWorkspaceLayout(page, 'section' in workspace)
    await expectNoPageOverflow(page)
  })

  test(`${workspace.name} has no serious or critical axe violations`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Axe runs once per route; layout smoke covers both configured viewports.')
    await openDemo(page, workspace.route)
    await expectNoBlockingAxeViolations(page)
  })
}

test('360 and 768 responsive smoke keeps every workspace inside the viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The responsive viewports are exercised once in addition to both configured projects.')

  for (const viewport of [{ width: 360, height: 768 }, { width: 768, height: 1024 }]) {
    await page.setViewportSize(viewport)
    for (const workspace of workspaces) {
      await test.step(`${viewport.width}px / ${workspace.name}`, async () => {
        await openDemo(page, workspace.route)
        await expect(page.locator('main h1')).toHaveText(workspace.heading)
        if ('section' in workspace) {
          await expect(page.locator('.mc-section-frame__header h2')).toHaveText(workspace.section)
        }
        await expectSharedWorkspaceLayout(page, 'section' in workspace)
        await expectNoPageOverflow(page)
      })
    }
  }
})

test('360px core workspaces have no serious or critical axe violations', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The mobile accessibility pass runs once.')
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 360, height: 768 })

  for (const workspace of workspaces.filter(({ name }) => [
    'dashboard',
    'flight',
    'airframe sensors',
    'airframe calibration',
    'propulsion',
    'propulsion esc',
    'control input',
    'joystick',
    'tuning pid',
    'tuning ekf',
    'flight data',
    'flight logs',
    'log analysis',
  ].includes(name))) {
    await test.step(workspace.name, async () => {
      await openDemo(page, workspace.route)
      await expectNoBlockingAxeViolations(page, { soft: true })
    })
  }
})
