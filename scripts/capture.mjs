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

async function discoverGameUrls(context) {
  const page = await context.newPage();

  try {
    await page.goto(CATALOG, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissSiteOverlays(page);
    await page.waitForTimeout(900);

    const hrefs = await page.locator("a[href]").evaluateAll((nodes) =>
      nodes.map((node) => node.href).filter(Boolean)
    );

    const unique = [];
    const seen = new Set();

    for (const raw of hrefs) {
      let url;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }

      if (url.hostname !== "www.pragmaticplay.fun") continue;
      if (!/^\/en\/slots\/[^/]+\/?$/i.test(url.pathname)) continue;

      const normalized = `${url.origin}${url.pathname.endsWith("/") ? url.pathname : url.pathname + "/"}`;
      if (normalized === CATALOG || seen.has(normalized)) continue;

      seen.add(normalized);
      unique.push(normalized);
    }

    console.log(`catalog: discovered ${unique.length} candidate detail URLs`);
    return unique.slice(0, MAX_CANDIDATES);
  } finally {
    await page.close().catch(() => {});
  }
}

async function pickMainDemoButton(page) {
  const buttons = page.locator("button, a").filter({ hasText: /^\s*Play Demo\s*$/i });
  const count = await buttons.count();

  for (let i = count - 1; i >= 0; i--) {
    const candidate = buttons.nth(i);
    try {
      if (await candidate.isVisible({ timeout: 250 })) return candidate;
    } catch {}
  }

  return null;
}

async function inferTitle(page, detailUrl) {
  try {
    const og = await page.locator('meta[property="og:title"]').getAttribute("content");
    const title = cleanTitle(og);
    if (title) return title;
  } catch {}

  for (const selector of ["h1", "h2"]) {
    try {
      const value = cleanTitle(await page.locator(selector).first().innerText({ timeout: 500 }));
      if (value && !/similar slot games|game attributes/i.test(value)) return value;
    } catch {}
  }

  const docTitle = cleanTitle(await page.title().catch(() => ""));
  if (docTitle) return docTitle;

  return new URL(detailUrl).pathname.split("/").filter(Boolean).at(-1) || "game";
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

async function openDemo(context, detailUrl) {
  const detail = await context.newPage();
  let popup = null;

  try {
    await detail.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissSiteOverlays(detail);
    await detail.waitForTimeout(500);

    const title = await inferTitle(detail, detailUrl);
    const button = await pickMainDemoButton(detail);

    if (!button) {
      throw new Error("no visible Play Demo button on detail page");
    }

    const popupPromise = context.waitForEvent("page", { timeout: 3500 }).catch(() => null);
    await button.click({ timeout: 7000 });
    popup = await popupPromise;

    const demo = popup || detail;

    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    }

    await waitUntilRendered(demo);
    return { detail, popup, demo, title };
  } catch (error) {
    if (popup && !popup.isClosed()) await popup.close().catch(() => {});
    if (!detail.isClosed()) await detail.close().catch(() => {});
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
  const seenTitles = new Set();

  try {
    const candidates = await discoverGameUrls(context);

    if (candidates.length < TARGET) {
      throw new Error(`catalog exposed only ${candidates.length} usable detail URLs`);
    }

    for (let i = 0; i < candidates.length && rows.length < TARGET; i++) {
      const detailUrl = candidates[i];
      let session = null;

      try {
        console.log(`[${rows.length + 1}/${TARGET}] ${detailUrl}`);
        session = await openDemo(context, detailUrl);

        const titleKey = session.title.toLowerCase();
        if (seenTitles.has(titleKey)) {
          console.log(`skip duplicate title: ${session.title}`);
          continue;
        }

        const { jpg, mode } = await captureBest(session.demo);
        const n = String(rows.length + 1).padStart(2, "0");
        const file = `${n}-${slugify(session.title)}.jpg`;

        await fs.writeFile(path.join(OUT, file), jpg);

        seenTitles.add(titleKey);
        rows.push({
          number: rows.length + 1,
          title: session.title,
          file,
          detailUrl,
          demoUrl: session.demo.url(),
          captureMode: mode,
          bytes: jpg.length,
          jpegQuality: 65,
          viewport: VIEWPORT,
          capturedAt: new Date().toISOString()
        });

        await writeIndex(rows, rows.length === TARGET);
        console.log(`saved ${file} (${jpg.length} bytes, ${mode})`);
      } catch (error) {
        console.warn(`candidate failed: ${error.message}`);
      } finally {
        if (session?.popup && !session.popup.isClosed()) {
          await session.popup.close().catch(() => {});
        }
        if (session?.detail && !session.detail.isClosed()) {
          await session.detail.close().catch(() => {});
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
