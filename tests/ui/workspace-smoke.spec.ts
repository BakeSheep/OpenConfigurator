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
  { name: 'settings', route: '/settings', heading: '飞行器设置', section: '机架' },
  { name: 'settings sensors', route: '/settings?section=sensors', heading: '飞行器设置', section: '传感器' },
  { name: 'settings actuators', route: '/settings?section=actuators', heading: '飞行器设置', section: '执行器' },
  { name: 'settings esc', route: '/settings?section=esc', heading: '飞行器设置', section: '电调' },
  { name: 'settings receiver', route: '/settings?section=receiver', heading: '飞行器设置', section: '遥控器' },
  { name: 'settings joystick', route: '/settings?section=joystick', heading: '飞行器设置', section: '游戏手柄' },
  { name: 'settings ports', route: '/settings?section=ports', heading: '飞行器设置', section: '端口' },
  { name: 'diagnostics', route: '/diagnostics', heading: '调参与诊断', section: '完整参数' },
  { name: 'diagnostics pid', route: '/diagnostics?section=pid', heading: '调参与诊断', section: 'PID 调参' },
  { name: 'diagnostics ekf', route: '/diagnostics?section=ekf', heading: '调参与诊断', section: 'EKF 融合' },
  { name: 'diagnostics waveforms', route: '/diagnostics?section=waveforms', heading: '调参与诊断', section: '实时波形' },
  { name: 'diagnostics messages', route: '/diagnostics?section=messages', heading: '调参与诊断', section: 'MAVLink 消息' },
  { name: 'diagnostics logs', route: '/diagnostics?section=logs', heading: '调参与诊断', section: '飞行日志' },
  { name: 'diagnostics log analysis', route: '/diagnostics?section=log-analysis', heading: '调参与诊断', section: '日志分析' },
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
    'settings sensors',
    'settings actuators',
    'settings esc',
    'settings receiver',
    'settings ports',
    'diagnostics pid',
    'diagnostics ekf',
    'diagnostics messages',
    'diagnostics logs',
    'diagnostics log analysis',
  ].includes(name))) {
    await test.step(workspace.name, async () => {
      await openDemo(page, workspace.route)
      await expectNoBlockingAxeViolations(page, { soft: true })
    })
  }
})
