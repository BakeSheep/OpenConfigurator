import { expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export const demoUrl = (route: string) => `/?demo=1#${route}`

export async function openDemo(page: Page, route: string) {
  await page.goto(demoUrl(route))
  await expect(page.locator('main h1')).toHaveCount(1)
  await expect(page.locator('main .mc-route-loading')).toHaveCount(0)
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
}

export async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const root = document.documentElement
    const body = document.body
    const viewportWidth = root.clientWidth

    const isRendered = (element: HTMLElement) => {
      const style = window.getComputedStyle(element)
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number.parseFloat(style.opacity || '1') > 0
    }

    const hasBoundedHorizontalScroller = (element: HTMLElement) => {
      let ancestor = element.parentElement
      while (ancestor && ancestor !== body) {
        const style = window.getComputedStyle(ancestor)
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
          const rect = ancestor.getBoundingClientRect()
          return rect.left >= -1 && rect.right <= viewportWidth + 1
        }
        ancestor = ancestor.parentElement
      }
      return false
    }

    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((element) => isRendered(element))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return {
          element: element.tagName.toLowerCase(),
          id: element.id,
          className: typeof element.className === 'string' ? element.className : '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          allowed: Boolean(element.closest('[data-allow-viewport-overflow], svg'))
            || hasBoundedHorizontalScroller(element),
        }
      })
      .filter(({ left, right, width, allowed }) => !allowed && width > 0 && (left < -1 || right > viewportWidth + 1))
      .slice(0, 8)

    return {
      viewportWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body.scrollWidth,
      offenders,
    }
  })

  expect(
    Math.max(dimensions.rootScrollWidth, dimensions.bodyScrollWidth),
    `Page overflow at ${page.url()} (viewport ${dimensions.viewportWidth}px). Offenders: ${JSON.stringify(dimensions.offenders)}`,
  ).toBeLessThanOrEqual(dimensions.viewportWidth + 1)
  expect(
    dimensions.offenders,
    `Visible elements are clipped outside the viewport at ${page.url()}: ${JSON.stringify(dimensions.offenders)}`,
  ).toEqual([])
}

export async function expectSharedWorkspaceLayout(page: Page, hasSectionNav: boolean) {
  const workspace = page.locator('main > .mc-workspace-frame')
  await expect(workspace).toHaveCount(1)
  await expect(workspace.locator(':scope > .mc-page-header')).toHaveCount(1)

  const geometry = await workspace.evaluate((element, shouldHaveSectionNav) => {
    const workspaceRect = element.getBoundingClientRect()
    const sectionLayout = element.querySelector<HTMLElement>(':scope > .mc-section-layout')
    const sectionNav = sectionLayout?.querySelector<HTMLElement>(':scope > .mc-section-nav') ?? null
    const sectionFrame = sectionLayout?.querySelector<HTMLElement>(':scope > .mc-section-frame') ?? null
    const navItems = sectionNav?.querySelector<HTMLElement>(':scope > .mc-section-nav__items') ?? null
    const navRect = sectionNav?.getBoundingClientRect() ?? null
    const sectionRect = sectionFrame?.getBoundingClientRect() ?? null

    return {
      shouldHaveSectionNav,
      compact: window.matchMedia('(max-width: 1180px)').matches,
      viewportWidth: document.documentElement.clientWidth,
      workspace: {
        left: workspaceRect.left,
        right: workspaceRect.right,
        width: workspaceRect.width,
      },
      sectionLayoutFound: Boolean(sectionLayout),
      navFound: Boolean(sectionNav),
      sectionFound: Boolean(sectionFrame),
      layoutColumns: sectionLayout ? window.getComputedStyle(sectionLayout).gridTemplateColumns : null,
      navWidth: navRect?.width ?? null,
      navFlexDirection: navItems ? window.getComputedStyle(navItems).flexDirection : null,
      nav: navRect && {
        left: navRect.left,
        right: navRect.right,
        top: navRect.top,
        bottom: navRect.bottom,
      },
      section: sectionRect && {
        left: sectionRect.left,
        right: sectionRect.right,
        top: sectionRect.top,
        bottom: sectionRect.bottom,
      },
    }
  }, hasSectionNav)

  expect(geometry.workspace.width, `Workspace width at ${page.url()}`).toBeLessThanOrEqual(1441)
  expect(geometry.workspace.left, `Workspace left edge at ${page.url()}`).toBeGreaterThanOrEqual(-1)
  expect(geometry.workspace.right, `Workspace right edge at ${page.url()}`).toBeLessThanOrEqual(geometry.viewportWidth + 1)

  if (!hasSectionNav) {
    expect(geometry.navFound, `Unexpected SectionNav at ${page.url()}`).toBe(false)
    return
  }

  expect(geometry.sectionLayoutFound, `Missing section layout at ${page.url()}`).toBe(true)
  expect(geometry.navFound, `Missing shared SectionNav at ${page.url()}`).toBe(true)
  expect(geometry.sectionFound, `Missing shared SectionFrame at ${page.url()}`).toBe(true)
  expect(geometry.nav).not.toBeNull()
  expect(geometry.section).not.toBeNull()

  const nav = geometry.nav!
  const section = geometry.section!
  expect(nav.left).toBeGreaterThanOrEqual(geometry.workspace.left - 1)
  expect(nav.right).toBeLessThanOrEqual(geometry.workspace.right + 1)
  expect(section.left).toBeGreaterThanOrEqual(geometry.workspace.left - 1)
  expect(section.right).toBeLessThanOrEqual(geometry.workspace.right + 1)

  if (geometry.compact) {
    expect(geometry.layoutColumns).not.toContain('176px')
    expect(geometry.navFlexDirection).toBe('row')
    expect(Math.abs((geometry.navWidth ?? 0) - (section.right - section.left))).toBeLessThanOrEqual(1)
    expect(Math.abs(nav.left - section.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(nav.right - section.right)).toBeLessThanOrEqual(1)
    expect(nav.bottom, `SectionNav overlaps content at ${page.url()}`).toBeLessThanOrEqual(section.top + 1)

    const sectionNav = workspace.locator(':scope > .mc-section-layout > .mc-section-nav')
    const activeLink = sectionNav.locator('.mc-section-nav__link[aria-current="page"]')
    await expect(activeLink).toHaveCount(1)
    await expect.poll(async () => {
      const [navBox, activeBox] = await Promise.all([sectionNav.boundingBox(), activeLink.boundingBox()])
      if (!navBox || !activeBox) return false
      return activeBox.x >= navBox.x - 1
        && activeBox.x + activeBox.width <= navBox.x + navBox.width + 1
    }, { message: `Active SectionNav link must be fully visible at ${page.url()}` }).toBe(true)
  } else {
    expect(geometry.layoutColumns).toMatch(/^176px\s/)
    expect(geometry.navFlexDirection).toBe('column')
    expect(geometry.navWidth).toBeGreaterThanOrEqual(175)
    expect(geometry.navWidth).toBeLessThanOrEqual(177)
    expect(nav.right, `SectionNav overlaps content at ${page.url()}`).toBeLessThanOrEqual(section.left + 1)
  }
}

export async function expectNoBlockingAxeViolations(page: Page, options: { soft?: boolean } = {}) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })),
    }))

  if (blocking.length > 0) {
    process.stderr.write(`Blocking axe violations at ${page.url()}: ${JSON.stringify(blocking)}\n`)
  }

  const assertion = options.soft
    ? expect.soft(blocking, `Blocking axe violations at ${page.url()}`)
    : expect(blocking, `Blocking axe violations at ${page.url()}`)
  assertion.toEqual([])
}

export function hashSearchParams(page: Page) {
  const hash = new URL(page.url()).hash.slice(1)
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : ''
  return new URLSearchParams(query)
}
