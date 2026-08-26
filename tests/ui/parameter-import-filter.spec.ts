import { expect, test } from '@playwright/test'
import { expectNoPageOverflow, openDemo } from './support'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mc-lang', 'zh')
    localStorage.setItem('mc-theme', 'light')
  })
})

test('parameter import preview filters writable, unchanged, and skipped rows', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 768 })
  await openDemo(page, '/tuning')
  await page.evaluate(async () => {
    const { useConnectionStore } = await import('/src/web/stores/connectionStore.ts')
    useConnectionStore.getState().setTarget(
      1,
      1,
      1,
      '00000000-0000-4000-8000-000000000001',
    )
  })

  await page.locator('input[type="file"][accept=".params,text/plain"]').setInputFiles({
    name: 'filter.params',
    mimeType: 'text/plain',
    buffer: Buffer.from([
      '1 1 MAV_SYS_ID 2 6',
      '1 1 MAV_COMP_ID 1 6',
      '1 1 UNKNOWN_PARAM 1 6',
      'not-a-qgc-row',
    ].join('\n')),
  })

  const dialog = page.getByRole('dialog', { name: 'QGC 参数文件差异预览' })
  await expect(dialog).toBeVisible()
  const panel = dialog.getByRole('tabpanel')

  await expect(dialog.getByRole('tab', { name: '待写入 1', selected: true })).toBeVisible()
  await expect(panel.getByText('MAV_SYS_ID', { exact: true })).toBeVisible()
  await expect(panel.getByText('MAV_COMP_ID', { exact: true })).toHaveCount(0)

  await dialog.getByRole('tab', { name: '值相同 1' }).click()
  await expect(dialog.getByRole('tab', { name: '值相同 1', selected: true })).toBeVisible()
  await expect(panel.getByText('MAV_COMP_ID', { exact: true })).toBeVisible()
  await expect(panel.getByText('MAV_SYS_ID', { exact: true })).toHaveCount(0)

  await dialog.getByRole('tab', { name: '值相同 1', selected: true }).press('End')
  await expect(dialog.getByRole('tab', { name: '跳过 2', selected: true })).toBeVisible()
  await expect(panel.getByText('UNKNOWN_PARAM', { exact: true })).toBeVisible()
  await expect(panel.getByText('第 4 行', { exact: true })).toBeVisible()
  await expect(panel.getByText('MAV_COMP_ID', { exact: true })).toHaveCount(0)
  await expectNoPageOverflow(page)
})
