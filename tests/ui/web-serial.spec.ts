import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mc-lang', 'zh')
    localStorage.setItem('mc-theme', 'light')
  })
})

test('connects an authorized local port through an injected Web Serial implementation', async ({ page }) => {
  await page.addInitScript(() => {
    const port: {
      readable: ReadableStream<Uint8Array> | null
      writable: WritableStream<Uint8Array> | null
      getInfo: () => SerialPortInfo
      open: (options: SerialOptions) => Promise<void>
      close: () => Promise<void>
    } = {
      readable: null,
      writable: null,
      getInfo: () => ({ usbVendorId: 0x1209, usbProductId: 0x5740 }),
      async open() {
        this.readable = new ReadableStream<Uint8Array>({
          start(controller) {
            // Valid MAVLink v1 ArduCopter heartbeat. Feed it after
            // transport_open so the browser Worker codec is exercised too.
            window.setTimeout(() => controller.enqueue(new Uint8Array([
              0xfe, 9, 0, 1, 1, 0, 0, 0, 0, 0, 2, 3, 0, 3, 3, 0xd5, 0x98,
            ])), 100)
          },
        })
        this.writable = new WritableStream<Uint8Array>()
      },
      async close() {
        this.readable = null
        this.writable = null
      },
    }
    Object.defineProperty(navigator, 'serial', {
      configurable: true,
      value: {
        getPorts: async () => [port],
        requestPort: async () => port,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => true,
      },
    })
  })

  await page.goto('/#/dashboard')
  await page.locator('button.mc-topbar__connect').click()
  await page.getByRole('button', { name: '+', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '连接飞控' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('combobox', { name: '端口' })).toContainText('USB 1209:5740')
  await dialog.getByRole('button', { name: '连接', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('button.mc-topbar__connect')).toContainText('USB 1209:5740')
})

test('explains the support boundary when Web Serial is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: undefined })
  })
  await page.goto('/#/dashboard')
  await page.locator('button.mc-topbar__connect').click()
  await page.getByRole('button', { name: '+', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '连接飞控' })).toContainText('Web Serial')
})
