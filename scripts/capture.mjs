import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const CATALOG = process.env.CATALOG_URL || "https://www.pragmaticplay.fun/en/slots/";
const TARGET = Number(process.env.GAME_LIMIT || 25);
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 90);
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

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s*[|–—-]\s*Pragmatic Play.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function clickIfVisible(locator, timeout = 900) {
  try {
    const first = locator.first();
    if (await first.isVisible({ timeout })) {
      await first.click({ timeout: 2500 });
      return true;
    }
  } catch {}
  return false;
}

async function dismissSiteOverlays(page) {
  for (const selector of ["#onetrust-accept-btn-handler", "[data-testid='cookie-accept-all']"]) {
    try {
      if (await clickIfVisible(page.locator(selector), 350)) break;
    } catch {}
  }

  for (const pattern of [/Accept all/i, /Accept cookies/i, /Allow all/i, /I agree/i]) {
    if (await clickIfVisible(page.getByRole("button", { name: pattern }), 350)) break;
  }

  for (const pattern of [
    /Yes, I am 18 years or older/i,
    /I am 18 years or older/i,
    /I am over 18/i
  ]) {
    if (await clickIfVisible(page.getByRole("button", { name: pattern }), 650)) break;
  }

  await page.waitForTimeout(250);
}

async function ensureCatalogButtons(page, wanted = 45) {
  for (let round = 0; round < 14; round++) {
    const count = await page.locator('[data-play-demo-open="true"][data-game-symbol]').count();
    if (count >= wanted) return count;

    const loadMore = page.getByRole("button", { name: /Load More/i });
    if (!(await clickIfVisible(loadMore, 650))) return count;

    await page.waitForTimeout(650);
  }

  return await page.locator('[data-play-demo-open="true"][data-game-symbol]').count();
}

async function discoverCandidates(context) {
  const page = await context.newPage();

  try {
    await page.goto(CATALOG, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissSiteOverlays(page);
    await page.waitForTimeout(700);
    await ensureCatalogButtons(page, Math.min(MAX_CANDIDATES, 55));

    const raw = await page
      .locator('[data-play-demo-open="true"][data-game-symbol]')
      .evaluateAll((nodes) => nodes.map((el) => {
        const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
        const symbol = clean(el.getAttribute("data-game-symbol"));
        const banner = clean(el.getAttribute("data-banner-image"));
        let title = "";

        for (let p = el.parentElement, depth = 0; p && depth < 9; p = p.parentElement, depth++) {
          const buttons = p.querySelectorAll('[data-play-demo-open="true"][data-game-symbol]');
          if (buttons.length !== 1) continue;

          for (const img of p.querySelectorAll("img[alt]")) {
            const alt = clean(img.getAttribute("alt"));
            if (
              alt &&
              alt.length < 120 &&
              !/pragmatic|logo|featured release|18\\+/i.test(alt)
            ) {
              title = alt;
              break;
            }
          }

          if (title) break;

          for (const heading of p.querySelectorAll("h1,h2,h3,h4,h5,h6,[class*='title'],[class*='name']")) {
            const text = clean(heading.textContent);
            if (
              text &&
              text.length < 120 &&
              !/play demo|more info|featured release|all slots|load more/i.test(text)
            ) {
              title = text;
              break;
            }
          }

          if (title) break;
        }

        return { symbol, title, banner };
      }));

    const seen = new Set();
    const candidates = [];

    for (const item of raw) {
      if (!item.symbol || seen.has(item.symbol)) continue;
      seen.add(item.symbol);
      candidates.push({
        symbol: item.symbol,
        title: item.title || item.symbol,
        banner: item.banner || null
      });
    }

    console.log(`catalog: discovered ${candidates.length} unique game symbols`);
    return candidates.slice(0, MAX_CANDIDATES);
  } finally {
    await page.close().catch(() => {});
  }
}

async function advanceObviousDialogs(page) {
  const patterns = [
    /^OK$/i,
    /^Continue$/i,
    /^Got it$/i,
    /^Skip$/i,
    /^I understand$/i
  ];

  for (let round = 0; round < 4; round++) {
    let acted = false;

    for (const frame of page.frames()) {
      for (const pattern of patterns) {
        try {
          const button = frame.getByRole("button", { name: pattern }).first();
          if (await button.isVisible({ timeout: 180 })) {
            await button.click({ timeout: 1200 });
            await page.waitForTimeout(250);
            acted = true;
            break;
          }
        } catch {}
      }

      if (acted) break;
    }

    if (!acted) break;
  }
}

async function hasLargeRenderSurface(page) {
  return await page.evaluate(() => {
    const area = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return 0;
      return Math.max(0, rect.width) * Math.max(0, rect.height);
    };

    return [...document.querySelectorAll("iframe, canvas")]
      .some((el) => area(el) > 150000);
  }).catch(() => false);
}

async function waitUntilRendered(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await dismissSiteOverlays(page).catch(() => {});
  await page.waitForTimeout(1800);

  for (let i = 0; i < 24; i++) {
    if (await hasLargeRenderSurface(page)) break;
    await page.waitForTimeout(400);
  }

  await advanceObviousDialogs(page);
  await page.waitForTimeout(900);
}

async function largestVisibleIframe(page) {
  const frames = page.locator("iframe:visible");
  const count = await frames.count();
  let best = null;
  let bestArea = 0;

  for (let i = 0; i < count; i++) {
    const locator = frames.nth(i);
    try {
      const box = await locator.boundingBox();
      if (!box) continue;
      const area = box.width * box.height;
      if (area > bestArea) {
        best = locator;
        bestArea = area;
      }
    } catch {}
  }

  return bestArea > 150000 ? best : null;
}

async function captureBest(page) {
  let best = null;
  let mode = "viewport";

  for (let attempt = 0; attempt < 3; attempt++) {
    const iframe = await largestVisibleIframe(page);
    let jpg;
    let currentMode;

    if (iframe) {
      jpg = await iframe.screenshot({
        type: "jpeg",
        quality: 65,
        animations: "disabled"
      });
      currentMode = "iframe";
    } else {
      jpg = await page.screenshot({
        type: "jpeg",
        quality: 65,
        fullPage: false,
        animations: "disabled"
      });
      currentMode = "viewport";
    }

    if (!best || jpg.length > best.length) {
      best = jpg;
      mode = currentMode;
    }

    if (attempt < 2) await page.waitForTimeout(1600);
  }

  if (!best || best.length < 15000) {
    throw new Error(`rendered screenshot too small (${best?.length || 0} bytes)`);
  }

  return { jpg: best, mode };
}

async function openCatalogCandidate(context, candidate) {
  const catalog = await context.newPage();
  let popup = null;

  try {
    await catalog.goto(CATALOG, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissSiteOverlays(catalog);
    await catalog.waitForTimeout(450);

    let button = catalog.locator(
      `[data-play-demo-open="true"][data-game-symbol="${candidate.symbol}"]`
    ).first();

    for (let round = 0; round < 14 && (await button.count()) === 0; round++) {
      const loadMore = catalog.getByRole("button", { name: /Load More/i });
      if (!(await clickIfVisible(loadMore, 500))) break;
      await catalog.waitForTimeout(550);
      button = catalog.locator(
        `[data-play-demo-open="true"][data-game-symbol="${candidate.symbol}"]`
      ).first();
    }

    if ((await button.count()) === 0) {
      throw new Error(`catalog button not found for ${candidate.symbol}`);
    }

    const clickedSymbol = await button.getAttribute("data-game-symbol");
    if (clickedSymbol !== candidate.symbol) {
      throw new Error(`symbol mismatch: expected ${candidate.symbol}, got ${clickedSymbol}`);
    }

    const popupPromise = context.waitForEvent("page", { timeout: 2800 }).catch(() => null);

    await button.evaluate((el) => el.click());
    await catalog.waitForTimeout(200);
    popup = await popupPromise;

    const demo = popup || catalog;

    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    }

    await waitUntilRendered(demo);
    return { catalog, popup, demo };
  } catch (error) {
    if (popup && !popup.isClosed()) await popup.close().catch(() => {});
    if (!catalog.isClosed()) await catalog.close().catch(() => {});
    throw error;
  }
}

async function writeIndex(rows, complete) {
  const index = {
    source: CATALOG,
    requested: TARGET,
    count: rows.length,
    complete,
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
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
      "--no-sandbox"
    ]
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    locale: "en-GB",
    reducedMotion: "reduce"
  });

  const rows = [];
  const seenSymbols = new Set();

  try {
    const candidates = await discoverCandidates(context);

    if (candidates.length < TARGET) {
      throw new Error(`catalog exposed only ${candidates.length} unique games`);
    }

    for (let i = 0; i < candidates.length && rows.length < TARGET; i++) {
      const candidate = candidates[i];
      let session = null;

      try {
        console.log(
          `[${rows.length + 1}/${TARGET}] ${candidate.title} [${candidate.symbol}]`
        );

        if (seenSymbols.has(candidate.symbol)) continue;
        session = await openCatalogCandidate(context, candidate);

        const { jpg, mode } = await captureBest(session.demo);
        const n = String(rows.length + 1).padStart(2, "0");
        const safeTitle = slugify(candidate.title);
        const file = `${n}-${safeTitle}-${candidate.symbol}.jpg`;

        await fs.writeFile(path.join(OUT, file), jpg);

        seenSymbols.add(candidate.symbol);
        rows.push({
          number: rows.length + 1,
          title: candidate.title,
          symbol: candidate.symbol,
          file,
          catalogUrl: CATALOG,
          demoUrl: session.demo.url(),
          banner: candidate.banner,
          captureMode: mode,
          bytes: jpg.length,
          jpegQuality: 65,
          viewport: VIEWPORT,
          capturedAt: new Date().toISOString()
        });

        await writeIndex(rows, rows.length === TARGET);
        console.log(
          `saved ${file} (${jpg.length} bytes, ${mode}, symbol=${candidate.symbol})`
        );
      } catch (error) {
        console.warn(
          `candidate ${candidate.symbol} failed: ${error.message}`
        );
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
    await writeIndex(rows, rows.length === TARGET).catch(() => {});
    await browser.close();
  }

  if (rows.length !== TARGET) {
    throw new Error(`Expected ${TARGET} screenshots, produced ${rows.length}`);
  }

  console.log(`done: ${rows.length} screenshots`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
