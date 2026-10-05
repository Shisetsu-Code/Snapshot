import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const CATALOG = "https://www.pragmaticplay.fun/en/slots/";
const TARGET = 25;
const MAX_CANDIDATES = 70;
const VIEWPORT = { width: 1280, height: 720 };
const OUT = path.resolve("snapshots");

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/™/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 80) || "game";
}

async function clickIfVisible(locator, timeout = 1200) {
  try {
    if (await locator.first().isVisible({ timeout })) {
      await locator.first().click({ timeout: 3000 });
      return true;
    }
  } catch {}
  return false;
}

async function dismissSiteOverlays(page) {
  const ageButtons = [
    page.getByRole("button", { name: /Yes, I am 18 years or older/i }),
    page.getByText(/Yes, I am 18 years or older/i, { exact: true })
  ];
  for (const locator of ageButtons) {
    if (await clickIfVisible(locator, 900)) break;
  }

  const cookiePatterns = [
    /Accept all/i,
    /Accept cookies/i,
    /Allow all/i,
    /I agree/i
  ];
  for (const pattern of cookiePatterns) {
    if (await clickIfVisible(page.getByRole("button", { name: pattern }), 500)) break;
  }

  await page.waitForTimeout(400);
}

function demoButtons(page) {
  return page.locator("button, a").filter({ hasText: /^\s*Play Demo\s*$/i });
}

async function ensureDemoCount(page, wanted) {
  for (let round = 0; round < 20; round++) {
    const count = await demoButtons(page).count();
    if (count > wanted) return count;

    const loadMore = page.getByRole("button", { name: /Load More/i });
    if (!(await clickIfVisible(loadMore, 700))) return count;

    await page.waitForTimeout(900);
  }
  return await demoButtons(page).count();
}

async function inferTitle(button, fallback) {
  try {
    const title = await button.evaluate((el) => {
      const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
      let p = el.parentElement;

      for (let depth = 0; p && depth < 10; depth++, p = p.parentElement) {
        const demos = [...p.querySelectorAll("button, a")]
          .filter((node) => /play demo/i.test(clean(node.textContent)));

        if (demos.length !== 1) continue;

        const headings = [...p.querySelectorAll("h1,h2,h3,h4,h5,h6,[class*='title'],[class*='name']")];
        for (const h of headings) {
          const t = clean(h.textContent);
          if (t && !/play demo|more info|featured release|all slots/i.test(t) && t.length < 120) {
            return t;
          }
        }

        const images = [...p.querySelectorAll("img[alt]")];
        for (const img of images) {
          const t = clean(img.getAttribute("alt"));
          if (t && !/pragmatic|logo|mega release/i.test(t) && t.length < 120) {
            return t;
          }
        }
      }

      return "";
    });

    return title || fallback;
  } catch {
    return fallback;
  }
}

async function advanceObviousDialogs(page) {
  const patterns = [
    /^OK$/i,
    /^Continue$/i,
    /^Got it$/i,
    /^Skip$/i,
    /^Close$/i,
    /^I understand$/i
  ];

  for (let round = 0; round < 3; round++) {
    let acted = false;
    for (const frame of page.frames()) {
      for (const pattern of patterns) {
        try {
          const loc = frame.getByRole("button", { name: pattern });
          if (await loc.first().isVisible({ timeout: 300 })) {
            await loc.first().click({ timeout: 1500 });
            acted = true;
            await page.waitForTimeout(250);
            break;
          }
        } catch {}
      }
    }
    if (!acted) break;
  }
}

async function waitUntilRendered(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);

  for (let i = 0; i < 20; i++) {
    const rendered = await page.evaluate(() => {
      const visibleArea = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return s.visibility !== "hidden" && s.display !== "none" && r.width * r.height;
      };

      const canvases = [...document.querySelectorAll("canvas")];
      const iframes = [...document.querySelectorAll("iframe")];
      return [...canvases, ...iframes].some((el) => visibleArea(el) > 180000);
    }).catch(() => false);

    if (rendered) break;
    await page.waitForTimeout(500);
  }

  await advanceObviousDialogs(page);
  await page.waitForTimeout(1000);
}

async function screenshotGame(page) {
  const frames = page.locator("iframe:visible");
  const count = await frames.count();
  let best = null;
  let bestArea = 0;

  for (let i = 0; i < count; i++) {
    const loc = frames.nth(i);
    try {
      const box = await loc.boundingBox();
      if (!box) continue;
      const area = box.width * box.height;
      if (area > bestArea) {
        best = loc;
        bestArea = area;
      }
    } catch {}
  }

  if (best && bestArea > 180000) {
    return await best.screenshot({ type: "jpeg", quality: 65 });
  }

  return await page.screenshot({
    type: "jpeg",
    quality: 65,
    fullPage: false,
    animations: "disabled"
  });
}

async function openCandidate(context, candidateIndex) {
  const catalog = await context.newPage();
  await catalog.goto(CATALOG, { waitUntil: "domcontentloaded", timeout: 30000 });
  await dismissSiteOverlays(catalog);
  await catalog.waitForTimeout(1000);

  const count = await ensureDemoCount(catalog, candidateIndex);
  if (count <= candidateIndex) {
    await catalog.close();
    return null;
  }

  const button = demoButtons(catalog).nth(candidateIndex);
  await button.scrollIntoViewIfNeeded();
  const title = await inferTitle(button, `Game ${candidateIndex + 1}`);

  const popupPromise = catalog.waitForEvent("popup", { timeout: 1500 }).catch(() => null);

  await button.click({ timeout: 10000 });
  const popup = await popupPromise;
  const demo = popup || catalog;

  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  }

  await waitUntilRendered(demo);
  return { catalog, demo, popup, title };
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage"
    ]
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-GB",
    reducedMotion: "reduce"
  });

  const seen = new Set();
  const rows = [];

  try {
    for (let candidateIndex = 0; candidateIndex < MAX_CANDIDATES && rows.length < TARGET; candidateIndex++) {
      let session = null;

      try {
        console.log(`[${rows.length + 1}/${TARGET}] candidate ${candidateIndex + 1}`);
        session = await openCandidate(context, candidateIndex);
        if (!session) break;

        const key = session.title.trim().toLowerCase();
        if (seen.has(key)) {
          console.log(`skip duplicate: ${session.title}`);
          continue;
        }

        const jpg = await screenshotGame(session.demo);
        if (!jpg || jpg.length < 12_000) {
          throw new Error(`screenshot too small (${jpg?.length || 0} bytes)`);
        }

        const n = String(rows.length + 1).padStart(2, "0");
        const file = `${n}-${slugify(session.title)}.jpg`;
        await fs.writeFile(path.join(OUT, file), jpg);

        seen.add(key);
        rows.push({
          number: rows.length + 1,
          title: session.title,
          file,
          catalogIndex: candidateIndex,
          demoUrl: session.demo.url(),
          jpegQuality: 65,
          viewport: VIEWPORT,
          capturedAt: new Date().toISOString()
        });

        console.log(`saved ${file} (${jpg.length} bytes)`);
      } catch (error) {
        console.warn(`candidate ${candidateIndex + 1} failed: ${error.message}`);
      } finally {
        if (session?.popup && !session.popup.isClosed()) {
          await session.popup.close().catch(() => {});
        }
        if (session?.catalog && !session.catalog.isClosed()) {
          await session.catalog.close().catch(() => {});
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (rows.length !== TARGET) {
    throw new Error(`Expected ${TARGET} screenshots, produced ${rows.length}`);
  }

  const index = {
    source: CATALOG,
    count: rows.length,
    jpegQuality: 65,
    viewport: VIEWPORT,
    generatedAt: new Date().toISOString(),
    games: rows
  };

  await fs.writeFile(
    path.join(OUT, "index.json"),
    JSON.stringify(index, null, 2) + "\n",
    "utf8"
  );

  console.log(`done: ${rows.length} screenshots`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
