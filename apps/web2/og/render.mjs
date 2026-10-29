/**
 * Renders apps/web2/og/og-image.html to apps/web2/public/og-image.png (1200x630), the
 * og:image / twitter:image of testmyagent.com. Run from the repository root:
 *
 *   node apps/web2/og/render.mjs
 *
 * Needs the root `playwright` devDependency and its chromium (`npx playwright install chromium`).
 * The template loads Geist from Google Fonts, so the render needs network access.
 * Commit the PNG together with any change to the template.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'public', 'og-image.png')

// CHROMIUM_PATH: use an installed chromium when the bundled one is a different build.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  await page.goto(pathToFileURL(join(here, 'og-image.html')).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const ok = await page.evaluate(() => document.fonts.check("600 64px 'Geist'"))
  if (!ok) throw new Error('Geist did not load; the image would use a fallback font')
  await page.screenshot({ path: out, type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } })
  console.log(`wrote ${out}`)
} finally {
  await browser.close()
}
