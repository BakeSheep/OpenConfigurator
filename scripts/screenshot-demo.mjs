// One-off README screenshot helper. It opens the Vite dev-only ?demo=1 mode
// through Playwright and never starts a device connection.
// Usage: node scripts/screenshot-demo.mjs [light|dark] [baseUrl]
import { chromium } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const theme = process.argv[2] === 'dark' ? 'dark' : 'light'
const baseUrl = process.argv[3] ?? 'http://localhost:5174'
const outputDirectory = resolve('docs/screenshots')
await mkdir(outputDirectory, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })

async function open(hash, settleMs = 3_000) {
  await page.goto(`${baseUrl}/?demo=1#${hash}`)
  await page.waitForTimeout(settleMs)
}

async function shoot(name) {
  const file = resolve(outputDirectory, `${name}.png`)
  await page.screenshot({ path: file, fullPage: false })
  console.log(`saved ${file}`)
}

try {
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem('mc-theme', selectedTheme)
  }, theme)

  await open('/dashboard', 5_000)
  if (await page.locator('html').getAttribute('data-theme') !== theme) {
    throw new Error(`theme did not switch to ${theme}`)
  }
  await shoot('dashboard')

  await open('/flight')
  await shoot('flight')

  await open('/diagnostics')
  await shoot('diagnostics')

  await open('/diagnostics?section=waveforms')
  for (const label of [/Yaw\s*\(/, /Climb\s*\(/]) {
    const checkbox = page.getByText(label).locator('input[type="checkbox"]')
    if (await checkbox.count()) await checkbox.first().click()
  }
  await page.waitForTimeout(12_000)
  await shoot('waveforms')

  await open('/settings')
  await shoot('settings')
} finally {
  await browser.close()
}
