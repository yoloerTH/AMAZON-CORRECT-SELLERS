import http from "http";
import { chromium } from "playwright";

// ─── MARKETPLACE DEFINITIONS ───────────────────────────────────────────────────

const ALL_MARKETPLACES = [
  { code: "UK", domain: "amazon.co.uk" },
  { code: "IE", domain: "amazon.ie" },
  { code: "DE", domain: "amazon.de" },
  { code: "NL", domain: "amazon.nl" },
  { code: "SE", domain: "amazon.se" },
  { code: "BE", domain: "amazon.com.be" },
  { code: "PL", domain: "amazon.pl" },
  { code: "ES", domain: "amazon.es" },
  { code: "IT", domain: "amazon.it" },
  { code: "AE", domain: "amazon.ae" },
  { code: "JP", domain: "amazon.co.jp" },
  { code: "SA", domain: "amazon.sa" },
  { code: "TR", domain: "amazon.com.tr" },
];

// ─── STATE ─────────────────────────────────────────────────────────────────────

let currentRun = null; // { status, startedAt, input, results, logs, error }

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(baseMs) {
  const jitter = baseMs * 0.5;
  return sleep(baseMs - jitter + Math.random() * jitter * 2);
}

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  if (currentRun) currentRun.logs.push(line);
}

function extractSellerIdFromHref(href) {
  try {
    const url = new URL(href, "https://www.amazon.com");
    return url.searchParams.get("seller");
  } catch {
    const match = href.match(/seller=([A-Z0-9]+)/);
    return match ? match[1] : null;
  }
}

// ─── BROWSER SETUP ─────────────────────────────────────────────────────────────

async function launchBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-GB",
    timezoneId: "Europe/London",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  return { browser, context };
}

// ─── STEP 1: PRODUCT PAGE ──────────────────────────────────────────────────────

async function scrapeProductPage(page, asin, marketplace) {
  const url = `https://www.${marketplace.domain}/dp/${asin}`;
  log(`  → Product page: ${url}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
  } catch (err) {
    log(`  ✗ Failed to load: ${err.message}`);
    return { primarySeller: null, hasOtherSellers: false };
  }

  const html = await page.content();
  if (
    html.includes("Enter the characters you see below") ||
    html.includes("Type the characters you see in this image")
  ) {
    log(`  ⚠ CAPTCHA detected on ${marketplace.code} — waiting 30s...`);
    await sleep(30000);
  }

  const pageTitle = await page.title();
  const hasProductTitle = await page.$("#productTitle").catch(() => null);
  if (
    (pageTitle.includes("Page Not Found") || html.includes("we couldn't find that page")) &&
    !hasProductTitle
  ) {
    log(`  ✗ Product not found on ${marketplace.code}`);
    return { primarySeller: null, hasOtherSellers: false };
  }

  let primarySeller = null;
  const sellerLink = await page.$("#sellerProfileTriggerId");
  if (sellerLink) {
    const name = await sellerLink.innerText();
    const href = await sellerLink.getAttribute("href");
    primarySeller = {
      name: name.trim(),
      sellerId: extractSellerIdFromHref(href || ""),
      source: "buy_box",
    };
    log(`  ✓ Buy box seller (3P): ${primarySeller.name} [${primarySeller.sellerId}]`);
  } else {
    const merchantDiv = await page.$("#merchantInfoFeature_feature_div");
    if (merchantDiv) {
      const text = await merchantDiv.innerText();
      if (text.toLowerCase().includes("amazon")) {
        primarySeller = { name: "Amazon", sellerId: null, source: "buy_box" };
        log(`  ✓ Buy box seller: Amazon`);
      }
    }
  }

  const otherSellersBox = await page.$("#dynamic-aod-ingress-box");
  const hasOtherSellers = !!otherSellersBox;
  if (hasOtherSellers) {
    const boxText = await otherSellersBox.innerText().catch(() => "");
    log(`  ✓ Other sellers: ${boxText.replace(/\n/g, " ").trim()}`);
  } else {
    log(`  ○ No other sellers`);
  }

  return { primarySeller, hasOtherSellers };
}

// ─── STEP 2: ALL OFFERS (AOD PANEL) ────────────────────────────────────────────

async function scrapeAllOffers(page) {
  log(`  → Opening all offers panel...`);
  const aodLink = await page.$("#aod-ingress-link");
  if (!aodLink) {
    log(`  ✗ AOD link not found`);
    return [];
  }

  try {
    await aodLink.click();
    await page.waitForSelector("#aod-offer-list", { timeout: 10000 });
    await sleep(2500);
  } catch (err) {
    log(`  ✗ AOD panel failed: ${err.message}`);
    return [];
  }

  const sellers = await page.evaluate(() => {
    function parseOffer(offer) {
      const link = offer.querySelector('a[href*="/gp/aag/main"]');
      if (!link) return null;
      const href = link.getAttribute("href");
      const name = link.textContent.trim();
      let sellerId = null;
      try {
        sellerId = new URL(href, window.location.origin).searchParams.get("seller");
      } catch {
        const m = href.match(/seller=([A-Z0-9]+)/);
        sellerId = m ? m[1] : null;
      }
      if (!sellerId) return null;

      const shipsFromEl = offer.querySelector('[id*="shipsFrom"] .a-col-right');
      const shipsFrom = shipsFromEl
        ? shipsFromEl.innerText.replace(/Dispatches from|Ships from/gi, "").replace(/\n/g, " ").trim()
        : "";
      const priceEl = offer.querySelector(".a-price .a-offscreen");
      const price = priceEl ? priceEl.textContent.trim() : "";

      return { name, sellerId, shipsFrom, price };
    }

    const results = [];
    const pinned = document.querySelector("#aod-pinned-offer");
    if (pinned) {
      const s = parseOffer(pinned);
      if (s) results.push(s);
    }
    const offers = document.querySelectorAll("#aod-offer-list #aod-offer");
    for (const offer of offers) {
      const s = parseOffer(offer);
      if (s) results.push(s);
    }
    return results;
  });

  const unique = [...new Map(sellers.map((s) => [s.sellerId, s])).values()];
  log(`  ✓ ${unique.length} unique sellers in AOD`);
  unique.forEach((s) => log(`    - ${s.name} [${s.sellerId}]`));

  try {
    const closeBtn = await page.$(
      'button[data-action="a-popover-close"], .aod-close-button, [aria-label="Close"]'
    );
    if (closeBtn) await closeBtn.click();
    await sleep(500);
  } catch {}

  return unique;
}

// ─── STEP 3: SELLER PROFILE ────────────────────────────────────────────────────

async function scrapeSellerProfile(page, sellerId, asin, marketplace) {
  const url = `https://www.${marketplace.domain}/sp?seller=${sellerId}&asin=${asin}`;
  log(`    → Seller profile: ${sellerId}`);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);
  } catch (err) {
    log(`    ✗ Failed: ${err.message}`);
    return null;
  }

  const sellerName = await page.$eval("h1", (el) => el.textContent.trim()).catch(() => "Unknown");

  const info = await page.evaluate(() => {
    const headingTexts = [
      "Detailed Seller Information",
      "Detaillierte Verkäuferinformationen",
      "Información detallada del vendedor",
      "Informazioni dettagliate sul venditore",
      "Informations détaillées sur le vendeur",
      "Gedetailleerde verkopersinformatie",
      "Detaljerad säljarinformation",
      "Szczegółowe informacje o sprzedawcy",
      "Satıcı Detaylı Bilgileri",
      "販売業者の詳細情報",
      "معلومات البائع التفصيلية",
      "معلومات تفصيلية عن البائع",
    ];

    const headings = Array.from(document.querySelectorAll("h3, h2, h4"));
    const h = headings.find((el) => headingTexts.some((t) => el.textContent.includes(t)));
    if (!h) return null;

    const container =
      h.closest(".a-box-inner") || h.closest(".a-box") || h.closest("section") || h.parentElement?.parentElement;
    if (!container) return null;

    const lines = container.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    const data = {};
    const addressLabels = [
      "business address", "customer services address",
      "geschäftsadresse", "kundenservice-adresse", "adresse",
      "dirección comercial", "indirizzo commerciale",
      "adres firmy", "iş adresi", "事業所の住所",
    ];

    const multiLineLabels = [...addressLabels];
    const singleLinePatterns = ["vat", "ust", "iva", "nip", "kdv", "trade register", "handelsregister", "registro mercantil", "phone", "telefon", "email", "e-mail", "business type", "business name"];

    for (let i = 0; i < lines.length; i++) {
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx === -1) continue;
      const key = lines[i].substring(0, colonIdx).trim();
      const value = lines[i].substring(colonIdx + 1).trim();
      if (!key) continue;

      const kLower = key.toLowerCase();
      const isAddress = multiLineLabels.some((a) => kLower.includes(a));
      const isSingleLine = singleLinePatterns.some((p) => kLower.includes(p));

      if (isAddress) {
        const parts = [];
        if (value) parts.push(value);
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].includes(":") || lines[j].toLowerCase().startsWith("this seller")) break;
          parts.push(lines[j]);
        }
        data[key] = parts.join(", ");
      } else if (isSingleLine) {
        if (value) data[key] = value;
      } else if (value) {
        data[key] = value;
      }
    }
    return data;
  });

  const csPhone = await page.evaluate(() => {
    const m = document.body.innerText.match(/Customer Service Phone[:\s]+([^\n]+)/i);
    return m ? m[1].trim() : null;
  });

  const out = { sellerName, sellerId };
  if (info) {
    for (const [key, value] of Object.entries(info)) {
      const k = key.toLowerCase();
      if (k.includes("business name") || k.includes("firmenname") || k.includes("nombre comercial") || k.includes("ragione sociale"))
        out.businessName = value;
      else if (k.includes("business type") || k.includes("unternehmenstyp") || k.includes("tipo de empresa"))
        out.businessType = value;
      else if (k.includes("trade register") || k.includes("handelsregister") || k.includes("registro mercantil"))
        out.tradeRegisterNumber = value;
      else if (k.includes("vat") || k.includes("ust") || k.includes("iva") || k.includes("nip") || k.includes("kdv")) {
        const looksLikeVat = /^[A-Z]{0,3}\d{5,}/.test(value) || /^\d{5,}/.test(value) || value.length < 30;
        out.vatNumber = looksLikeVat ? value : "";
      }
      else if (k.includes("phone") || k.includes("telefon") || k.includes("teléfono") || k.includes("電話"))
        out.phone = value;
      else if (k.includes("email") || k.includes("e-mail") || k.includes("メール"))
        out.email = value;
      else if (k.includes("business address") || k.includes("geschäftsadresse") || k.includes("dirección comercial"))
        out.businessAddress = value;
      else if (k.includes("customer service") || k.includes("kundenservice"))
        out.customerServiceAddress = value;
    }
  }

  if (csPhone && !out.phone) out.phone = csPhone;
  if (csPhone && out.phone && csPhone !== out.phone) out.customerServicePhone = csPhone;

  log(`    ✓ ${sellerName}: phone=${out.phone || "—"}, email=${out.email || "—"}`);
  return out;
}

// ─── SCRAPER RUNNER ────────────────────────────────────────────────────────────

async function runScraper(input) {
  const {
    asins = [],
    maxAsins = 0,
    marketplaces: marketplaceFilter = [],
    delayBetweenRequests = 3000,
    skipAmazonSellers = true,
  } = input;

  const asinsToProcess = maxAsins > 0 ? asins.slice(0, maxAsins) : asins;
  const marketplaces =
    marketplaceFilter.length > 0
      ? ALL_MARKETPLACES.filter((m) => marketplaceFilter.includes(m.code))
      : ALL_MARKETPLACES;

  log(`Config: ${asinsToProcess.length} ASINs × ${marketplaces.length} marketplaces`);
  log(`Delay: ~${delayBetweenRequests}ms | Skip Amazon sellers: ${skipAmazonSellers}`);

  const { browser, context } = await launchBrowser();
  const results = [];

  try {
    for (const asin of asinsToProcess) {
      log(`\n${"═".repeat(60)}`);
      log(`ASIN: ${asin}`);
      log(`${"═".repeat(60)}`);

      for (const marketplace of marketplaces) {
        log(`\n─── ${marketplace.code} (${marketplace.domain}) ───`);
        const page = await context.newPage();

        try {
          const { primarySeller, hasOtherSellers } = await scrapeProductPage(page, asin, marketplace);
          const sellersToVisit = new Map();

          if (primarySeller?.sellerId) {
            sellersToVisit.set(primarySeller.sellerId, {
              name: primarySeller.name,
              source: "buy_box",
            });
          }

          if (hasOtherSellers) {
            const aodSellers = await scrapeAllOffers(page);
            for (const s of aodSellers) {
              if (!sellersToVisit.has(s.sellerId)) {
                sellersToVisit.set(s.sellerId, {
                  name: s.name,
                  source: "other_offers",
                  shipsFrom: s.shipsFrom,
                  price: s.price,
                });
              }
            }
          }

          if (skipAmazonSellers && sellersToVisit.size === 0 && primarySeller?.name === "Amazon") {
            log(`  ○ Amazon-only listing, skipping`);
            await page.close();
            await randomDelay(delayBetweenRequests);
            continue;
          }

          log(`  → ${sellersToVisit.size} 3P seller(s) to scrape`);

          for (const [sellerId, meta] of sellersToVisit) {
            await randomDelay(delayBetweenRequests);
            const profile = await scrapeSellerProfile(page, sellerId, asin, marketplace);

            const row = {
              asin,
              marketplace: marketplace.code,
              domain: marketplace.domain,
              source: meta.source,
              sellerId,
              sellerDisplayName: meta.name,
              sellerName: profile?.sellerName || meta.name,
              businessName: profile?.businessName || "",
              businessType: profile?.businessType || "",
              tradeRegisterNumber: profile?.tradeRegisterNumber || "",
              vatNumber: profile?.vatNumber || "",
              phone: profile?.phone || "",
              email: profile?.email || "",
              businessAddress: profile?.businessAddress || "",
              customerServiceAddress: profile?.customerServiceAddress || "",
              customerServicePhone: profile?.customerServicePhone || "",
              shipsFrom: meta.shipsFrom || "",
              price: meta.price || "",
            };
            results.push(row);
          }

          if (sellersToVisit.size === 0) {
            results.push({
              asin,
              marketplace: marketplace.code,
              domain: marketplace.domain,
              source: primarySeller ? "buy_box" : "not_found",
              sellerId: "",
              sellerDisplayName: primarySeller?.name || "N/A",
              sellerName: primarySeller?.name || "N/A",
              businessName: "", businessType: "", tradeRegisterNumber: "",
              vatNumber: "", phone: "", email: "", businessAddress: "",
              customerServiceAddress: "", customerServicePhone: "",
              shipsFrom: "", price: "",
            });
          }
        } catch (err) {
          log(`  ✗ Error: ${err.message}`);
          results.push({
            asin,
            marketplace: marketplace.code,
            domain: marketplace.domain,
            source: "error",
            error: err.message,
            sellerId: "", sellerDisplayName: "", sellerName: "",
            businessName: "", businessType: "", tradeRegisterNumber: "",
            vatNumber: "", phone: "", email: "", businessAddress: "",
            customerServiceAddress: "", customerServicePhone: "",
            shipsFrom: "", price: "",
          });
        } finally {
          await page.close();
        }

        await randomDelay(delayBetweenRequests);
      }
    }
  } finally {
    await browser.close();
  }

  log(`\n${"═".repeat(60)}`);
  log(`DONE — ${results.length} rows`);
  log(`${"═".repeat(60)}`);

  return results;
}

// ─── HTTP SERVER ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // POST /run — start a scrape
  if (req.method === "POST" && url.pathname === "/run") {
    if (currentRun?.status === "running") {
      return json(res, 409, {
        error: "A run is already in progress",
        startedAt: currentRun.startedAt,
      });
    }

    const input = await readBody(req);
    if (!input?.asins?.length) {
      return json(res, 400, { error: "Missing 'asins' array in request body" });
    }

    currentRun = {
      status: "running",
      startedAt: new Date().toISOString(),
      input,
      results: [],
      logs: [],
      error: null,
    };

    json(res, 202, { status: "started", startedAt: currentRun.startedAt });

    // Run in background
    runScraper(input)
      .then((results) => {
        currentRun.status = "completed";
        currentRun.results = results;
        currentRun.completedAt = new Date().toISOString();
      })
      .catch((err) => {
        currentRun.status = "failed";
        currentRun.error = err.message;
        currentRun.completedAt = new Date().toISOString();
        console.error("Run failed:", err);
      });

    return;
  }

  // GET /status — check current/last run
  if (req.method === "GET" && url.pathname === "/status") {
    if (!currentRun) {
      return json(res, 200, { status: "idle", message: "No runs yet" });
    }
    return json(res, 200, {
      status: currentRun.status,
      startedAt: currentRun.startedAt,
      completedAt: currentRun.completedAt || null,
      resultCount: currentRun.results.length,
      logCount: currentRun.logs.length,
      error: currentRun.error,
    });
  }

  // GET /results — get results from last run
  if (req.method === "GET" && url.pathname === "/results") {
    if (!currentRun) {
      return json(res, 200, { status: "idle", results: [] });
    }
    return json(res, 200, {
      status: currentRun.status,
      results: currentRun.results,
    });
  }

  // GET /logs — get logs from current/last run
  if (req.method === "GET" && url.pathname === "/logs") {
    if (!currentRun) {
      return json(res, 200, { logs: [] });
    }
    return json(res, 200, {
      status: currentRun.status,
      logs: currentRun.logs,
    });
  }

  // GET / — health check
  if (req.method === "GET" && url.pathname === "/") {
    return json(res, 200, {
      service: "amazon-seller-scraper",
      status: currentRun?.status || "idle",
      uptime: process.uptime(),
    });
  }

  json(res, 404, { error: "Not found" });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Endpoints:`);
  console.log(`  POST /run     — start a scrape (body: { asins, maxAsins, marketplaces, ... })`);
  console.log(`  GET  /status  — check run status`);
  console.log(`  GET  /results — get results`);
  console.log(`  GET  /logs    — get logs`);
});
