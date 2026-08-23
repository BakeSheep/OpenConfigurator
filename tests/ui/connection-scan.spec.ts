import { test, expect } from '@playwright/test'

// Focused coverage for the discovery-v2 connect dialog (connection
// compatibility plan §Phase 1/§2): per-kind scan requests, recommended-only
// USB list with the explicit "show all ports" escape hatch, display names,
// single-candidate preselect, and paired-but-offline Bluetooth entries.

const serialDevice = {
  path: '/dev/ttyACM0',
  transport: 'serial',
  deviceId: 'serial:abc123',
  displayName: 'Pixhawk …34AA',
  manufacturer: 'Pixhawk',
  serialNumber: '000A34AA',
  stablePath: '/dev/serial/by-id/usb-Pixhawk_000A34AA-if00',
  recommended: true,
}

const platformUart = {
  path: '/dev/ttyS17',
  transport: 'serial',
  deviceId: 'serial:uart17',
  recommended: false,
}

const pairedOfflineBluetooth = {
  path: 'bt-spp://08fad1176949',
  transport: 'bluetooth-spp',
  deviceId: 'bt-spp:deadbeef',
  displayName: 'MicoAir743v2',
  friendlyName: 'MicoAir743v2',
  bluetoothAddress: '08:FA:D1:17:69:49',
  availability: 'paired',
  requiresDeepResolution: true,
  recommended: true,
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('mc-lang')) localStorage.setItem('mc-lang', 'zh')
    if (!localStorage.getItem('mc-theme')) localStorage.setItem('mc-theme', 'light')
  })
})

test('connect dialog scans each transport kind independently with scoped requests', async ({ page }) => {
  const requests: string[] = []
  await page.routeWebSocket('ws://127.0.0.1:3000/ws', () => {})
  await page.route('**/api/connections/scan*', async (route) => {
    const url = new URL(route.request().url())
    const kind = url.searchParams.get('kind') ?? 'legacy'
    const scope = url.searchParams.get('scope') ?? '-'
    requests.push(`${kind}:${scope}`)
    if (kind === 'bluetooth') {
      await route.fulfill({
        json: {
          success: true,
          data: {
            kind,
            scope: 'quick',
            scanGeneration: requests.length,
            cached: false,
            devices: [pairedOfflineBluetooth],
            warnings: [],
          },
        },
      })
      return
    }
    await route.fulfill({
      json: {
        success: true,
        data: {
          kind,
          scope,
          scanGeneration: requests.length,
          cached: false,
          devices: scope === 'all' ? [serialDevice, platformUart] : [serialDevice],
          warnings: [],
        },
      },
    })
  })

  await page.goto('/#/dashboard')
  await expect(page.locator('main h1')).toHaveCount(1)

  await page.locator('button.mc-topbar__connect').click()
  await page.getByRole('button', { name: '+', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  // USB recommended scan runs on open; Bluetooth is not contacted yet.
  await expect(dialog.getByLabel('端口')).toHaveValue('/dev/ttyACM0')
  await expect(requests).toEqual(['serial:recommended'])

  const serialSelect = dialog.getByLabel('端口')
  await expect(serialSelect.locator('option')).toHaveCount(2)
  await expect(serialSelect.locator('option').nth(1)).toHaveText('Pixhawk …34AA · /dev/ttyACM0')

  // "Show all ports" is the only way platform UARTs enter the list.
  await dialog.getByRole('button', { name: '显示全部端口' }).click()
  await expect(serialSelect.locator('option')).toHaveCount(3)
  await expect(serialSelect.locator('option', { hasText: '/dev/ttyS17' })).toHaveCount(1)
  await expect(requests).toEqual(['serial:recommended', 'serial:all'])

  // Switching to Bluetooth only now triggers the quick scan.
  await dialog.getByRole('radio', { name: '蓝牙' }).click()
  const bluetoothSelect = dialog.getByLabel('蓝牙设备')
  await expect(bluetoothSelect.locator('option', { hasText: 'MicoAir743v2' })).toHaveCount(1)
  await expect(
    bluetoothSelect.locator('option', { hasText: '已配对 · 设备上电后连接' }),
  ).toHaveCount(1)
  await expect(requests).toEqual(['serial:recommended', 'serial:all', 'bluetooth:quick'])
})

test('serial preset uses only the serial scan and sends stable identity', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('oc-connection-presets', JSON.stringify([{
      id: 'serial-stable',
      name: 'Pixhawk preset',
      type: 'serial',
      port: '/dev/ttyACM9',
      baudRate: 57600,
      deviceId: 'serial:abc123',
      serialNumber: '000A34AA',
      stablePath: '/dev/serial/by-id/usb-Pixhawk_000A34AA-if00',
      transport: 'serial',
    }]))
  })
  await page.routeWebSocket('ws://127.0.0.1:3000/ws', () => {})
  const scanRequests: string[] = []
  let connectBody: Record<string, unknown> | null = null
  await page.route('**/api/connections/scan*', async (route) => {
    scanRequests.push(route.request().url())
    await route.fulfill({
      json: {
        success: true,
        data: {
          kind: 'serial',
          scope: 'recommended',
          scanGeneration: 1,
          cached: false,
          devices: [serialDevice],
          warnings: [],
        },
      },
    })
  })
  await page.route('**/api/connections/connect', async (route) => {
    connectBody = route.request().postDataJSON()
    await route.fulfill({ json: { success: true } })
  })

  await page.goto('/#/dashboard')
  await page.locator('button.mc-topbar__connect').click()
  await page.getByRole('button', { name: /^Pixhawk preset/ }).click()

  await expect.poll(() => scanRequests.length).toBe(1)
  const scanUrl = new URL(scanRequests[0])
  expect(scanUrl.searchParams.get('kind')).toBe('serial')
  expect(scanUrl.searchParams.get('scope')).toBe('recommended')
  await expect.poll(() => connectBody).not.toBeNull()
  expect(connectBody).toMatchObject({
    type: 'serial',
    port: '/dev/ttyACM0',
    deviceId: serialDevice.deviceId,
    stablePath: serialDevice.stablePath,
    serialNumber: serialDevice.serialNumber,
    transport: 'serial',
  })
})
