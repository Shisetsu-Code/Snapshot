import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const CATALOG = "https://www.pragmaticplay.fun/en/slots/";
const TARGET = 25;
const MAX_CANDIDATES = 48;
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
    const first = locator.first();
    if (!(await first.isVisible({ timeout }))) return false;

    try {
      await first.click({ timeout: 1800 });
    } catch {
      await first.evaluate((el) => el.click());
    }

    return true;
  } catch {}

  return false;
}

async function domClickFirst(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if ((await locator.count()) > 0) {
        await locator.evaluate((el) => el.click());
        return true;
      }
    } catch {}
  }

  return false;
}

async function domClickText(page, patterns) {
  return await page.evaluate((sources) => {
    const regexes = sources.map((source) => new RegExp(source, "i"));
    const roots = [document];
    const elements = [];

    while (roots.length) {
      const root = roots.pop();
      for (const el of root.querySelectorAll("button,a,[role='button'],input[type='button'],input[type='submit']")) {
        elements.push(el);
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }

    for (const el of elements) {
      const text = (el.textContent || el.value || "").replace(/\\s+/g, " ").trim();
      if (regexes.some((rx) => rx.test(text))) {
        el.click();
        return text;
      }
    }

    return null;
  }, patterns.map((rx) => rx.source)).catch(() => null);
}

async function waitTextGone(page, pattern, timeout = 5000) {
  try {
    await page.getByText(pattern).first().waitFor({ state: "hidden", timeout });
    return true;
  } catch {
    return false;
  }
}

async function dismissSiteOverlays(page) {
  // Cookie consent first. Its overlay can intercept the age-confirmation control.
  const cookieText = /We value your privacy/i;
  const cookieVisible = await page.getByText(cookieText).first().isVisible({ timeout: 600 }).catch(() => false);

  if (cookieVisible) {
    const clicked =
      await domClickFirst(page, [
        "#onetrust-accept-btn-handler",
        "button#onetrust-accept-btn-handler",
        "[data-testid='cookie-accept-all']"
      ]) ||
      await domClickText(page, [
        /^Accept All$/i,
        /^Accept all$/i,
        /Accept cookies/i,
        /Allow all/i
      ]);

    if (clicked) {
      await waitTextGone(page, cookieText, 6000);
      await page.waitForTimeout(350);
    }
  }

  // Then confirm the official 18+ gate.
  const ageText = /Pragmatic Play content is intended for persons 18 years and above/i;
  const ageVisible = await page.getByText(ageText).first().isVisible({ timeout: 600 }).catch(() => false);

  if (ageVisible) {
    const clicked =
      await domClickText(page, [
        /^Yes, I am 18 years or older$/i,
        /Yes, I am 18 years or older/i
      ]);

    if (clicked) {
      await waitTextGone(page, ageText, 6000);
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  // Some deployments mount the cookie layer again after age confirmation.
  const cookieAgain = await page.getByText(cookieText).first().isVisible({ timeout: 300 }).catch(() => false);
  if (cookieAgain) {
    await domClickFirst(page, ["#onetrust-accept-btn-handler"]);
    await domClickText(page, [/^Accept All$/i, /^Accept all$/i]);
    await waitTextGone(page, cookieText, 4000);
  }

  await page.waitForTimeout(300);
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
  await page.waitForLoadState("domcontentloaded", { timeout: 7000 }).catch(() => {});
  await dismissSiteOverlays(page).catch(() => {});
  await page.waitForTimeout(1800);

  let rendered = false;

  for (let i = 0; i < 18; i++) {
    rendered = await page.evaluate(() => {
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
    await page.waitForTimeout(450);
  }

  if (!rendered) {
    throw new Error("game render surface not found");
  }

  const blockedByAge = await page
    .getByText(/Pragmatic Play content is intended for persons 18 years and above/i)
    .first()
    .isVisible({ timeout: 250 })
    .catch(() => false);

  const blockedByCookies = await page
    .getByText(/We value your privacy/i)
    .first()
    .isVisible({ timeout: 250 })
    .catch(() => false);

  if (blockedByAge || blockedByCookies) {
    throw new Error("consent overlay still visible");
  }

  await advanceObviousDialogs(page);
  await page.waitForTimeout(900);
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
  await catalog.goto(CATALOG, { waitUntil: "domcontentloaded", timeout: 20000 });
  await dismissSiteOverlays(catalog);
  await catalog.waitForTimeout(1000);

  const count = await ensureDemoCount(catalog, candidateIndex);
  if (count <= candidateIndex) {
    await catalog.close();
    return null;
  }

  const button = demoButtons(catalog).nth(candidateIndex);
  const title = await inferTitle(button, `Game ${candidateIndex + 1}`);

  const popupPromise = catalog.waitForEvent("popup", { timeout: 2500 }).catch(() => null);

  // The catalog keeps some valid game cards outside Chromium's reported viewport.
  // Trigger the site's own Play Demo handler directly instead of requiring
  // Playwright's physical scroll/click actionability check.
  await button.evaluate((el) => el.click());
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

  // Establish consent once in this browser context so every parallel catalog
  // tab inherits the same cookie/localStorage state.
  const bootstrap = await context.newPage();
  await bootstrap.goto(CATALOG, { waitUntil: "domcontentloaded", timeout: 20000 });
  await dismissSiteOverlays(bootstrap);

  const ageVisible = await bootstrap
    .getByText(/Pragmatic Play content is intended for persons 18 years and above/i)
    .first()
    .isVisible({ timeout: 300 })
    .catch(() => false);

  const cookiesVisible = await bootstrap
    .getByText(/We value your privacy/i)
    .first()
    .isVisible({ timeout: 300 })
    .catch(() => false);

  if (ageVisible || cookiesVisible) {
    const controls = await bootstrap.locator("button,a,[role='button']").evaluateAll((nodes) =>
      nodes.map((el, i) => ({
        i,
        text: (el.textContent || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 160),
        id: el.id || null,
        cls: typeof el.className === "string" ? el.className.slice(0, 180) : null,
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      })).filter((x) => x.text)
    ).catch(() => []);

    console.log("CONSENT_DEBUG_CONTROLS=" + JSON.stringify(controls.slice(0, 120)));
    console.log("CONSENT_DEBUG_FRAMES=" + JSON.stringify(
      bootstrap.frames().map((frame) => frame.url())
    ));

    await fs.mkdir(OUT, { recursive: true });
    await bootstrap.screenshot({
      path: path.join(OUT, "debug-consent.jpg"),
      type: "jpeg",
      quality: 65,
      fullPage: false
    }).catch(() => {});

    throw new Error(
      `could not establish catalog consent state (age=${ageVisible}, cookies=${cookiesVisible})`
    );
  }

  await bootstrap.close();

  const BATCH_SIZE = 4;

  try {
    for (let base = 0; base < MAX_CANDIDATES && rows.length < TARGET; base += BATCH_SIZE) {
      const indices = Array.from(
        { length: Math.min(BATCH_SIZE, MAX_CANDIDATES - base) },
        (_, i) => base + i
      );

      const captures = await Promise.all(indices.map(async (candidateIndex) => {
        let session = null;

        try {
          console.log(`[candidate ${candidateIndex + 1}] opening`);
          session = await openCandidate(context, candidateIndex);
          if (!session) return null;

          const jpg = await screenshotGame(session.demo);
          if (!jpg || jpg.length < 12_000) {
            throw new Error(`screenshot too small (${jpg?.length || 0} bytes)`);
          }

          return {
            candidateIndex,
            title: session.title,
            demoUrl: session.demo.url(),
            jpg
          };
        } catch (error) {
          console.warn(`candidate ${candidateIndex + 1} failed: ${error.message}`);
          return null;
        } finally {
          if (session?.popup && !session.popup.isClosed()) {
            await session.popup.close().catch(() => {});
          }
          if (session?.catalog && !session.catalog.isClosed()) {
            await session.catalog.close().catch(() => {});
          }
        }
      }));

      for (const capture of captures) {
        if (!capture || rows.length >= TARGET) continue;

        const key = capture.title.trim().toLowerCase();
        if (seen.has(key)) {
          console.log(`skip duplicate: ${capture.title}`);
          continue;
        }

        const n = String(rows.length + 1).padStart(2, "0");
        const file = `${n}-${slugify(capture.title)}.jpg`;
        await fs.writeFile(path.join(OUT, file), capture.jpg);

        seen.add(key);
        rows.push({
          number: rows.length + 1,
          title: capture.title,
          file,
          catalogIndex: capture.candidateIndex,
          demoUrl: capture.demoUrl,
          jpegQuality: 65,
          viewport: VIEWPORT,
          capturedAt: new Date().toISOString()
        });

        console.log(`saved ${file} (${capture.jpg.length} bytes)`);
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
