#!/usr/bin/env node

"use strict";

require("dotenv").config();

const { chromium } = require("playwright-core");

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function cleanText(value = "") {
    return String(value).replace(/\s+/g, " ").trim();
}

async function firstVisible(locators) {
    for (const locator of locators) {
        try {
            const count = await locator.count();

            for (let index = 0; index < count; index += 1) {
                const item = locator.nth(index);

                if (await item.isVisible().catch(() => false)) {
                    return item;
                }
            }
        } catch {}
    }

    return null;
}

async function getReadinessSnapshot(page) {
    const url = page && !page.isClosed() ? page.url() : "";
    const title = page && !page.isClosed()
        ? await page.title().catch(() => "")
        : "";

    const bodyText = page && !page.isClosed()
        ? cleanText(
            await page
                .locator("body")
                .innerText({ timeout: 3_000 })
                .catch(() => ""),
        )
        : "";

    const searchBox = page && !page.isClosed()
        ? await firstVisible([
            page.locator('input[aria-label="Search Nextdoor"]'),
            page.locator('input[placeholder*="Search Nextdoor" i]'),
            page.locator('input[type="search"]'),
            page.locator('[data-testid="search-input"] input'),
        ])
        : null;

    const forSaleAndFree = page && !page.isClosed()
        ? await firstVisible([
            page.getByText("For Sale & Free", { exact: true }),
            page.getByRole("link", { name: /For Sale & Free/i }),
            page.getByRole("button", { name: /For Sale & Free/i }),
            page.locator('a[href*="/for_sale_and_free"]'),
        ])
        : null;

    const mainShell = page && !page.isClosed()
        ? await firstVisible([
            page.locator("main"),
            page.locator('[role="main"]'),
            page.locator('a[href*="/news_feed"]'),
            page.locator('a[href*="/for_sale_and_free"]'),
        ])
        : null;

    const dialogCount = page && !page.isClosed()
        ? await page
            .locator('[role="dialog"], [aria-modal="true"]')
            .count()
            .catch(() => 0)
        : 0;

    const isNextdoor = /(^https?:\/\/)?([^/]+\.)?nextdoor\.com/i.test(url);
    const isLoginOrInterstitial = /\/(login|verify|choose_address|checkpoint)/i.test(url);
    const looksLoggedOut = /(?:log in|sign in|join nextdoor|sign up)/i.test(
        bodyText.slice(0, 2_000),
    );

    return {
        url,
        title,
        bodyText,
        searchBoxVisible: Boolean(searchBox),
        forSaleVisible: Boolean(forSaleAndFree),
        mainShellVisible: Boolean(mainShell),
        dialogCount,
        isNextdoor,
        isLoginOrInterstitial,
        looksLoggedOut,
    };
}

function isStrictReady(snapshot) {
    return Boolean(
        snapshot.isNextdoor &&
        !snapshot.isLoginOrInterstitial &&
        !snapshot.looksLoggedOut &&
        (
            snapshot.searchBoxVisible ||
            snapshot.forSaleVisible
        ),
    );
}

function isAuthenticatedShell(snapshot) {
    return Boolean(
        snapshot.isNextdoor &&
        !snapshot.isLoginOrInterstitial &&
        !snapshot.looksLoggedOut &&
        snapshot.mainShellVisible &&
        snapshot.bodyText.length >= 500,
    );
}

function logDiagnostics(snapshot, attempt, phase) {
    console.error(
        `🩺 Nextdoor preflight diagnostics ` +
        `(attempt ${attempt}/2, ${phase})`,
    );
    console.error(`   URL: ${snapshot.url || "(empty)"}`);
    console.error(`   Title: ${snapshot.title || "(empty)"}`);
    console.error(`   Search box visible: ${snapshot.searchBoxVisible}`);
    console.error(`   For Sale & Free visible: ${snapshot.forSaleVisible}`);
    console.error(`   Main shell visible: ${snapshot.mainShellVisible}`);
    console.error(`   Dialog/overlay count: ${snapshot.dialogCount}`);
    console.error(`   Login/interstitial URL: ${snapshot.isLoginOrInterstitial}`);
    console.error(`   Looks logged out: ${snapshot.looksLoggedOut}`);
    console.error(
        `   Body excerpt: ${snapshot.bodyText.slice(0, 1_000) || "(empty)"}`,
    );
}

async function waitForStrictReady(page, timeoutMs, attempt, phase) {
    const deadline = Date.now() + timeoutMs;
    let lastSnapshot = await getReadinessSnapshot(page);

    while (Date.now() < deadline) {
        lastSnapshot = await getReadinessSnapshot(page);

        if (isStrictReady(lastSnapshot)) {
            console.log(
                `✅ Fresh Nextdoor tab is ready (${phase}): ${lastSnapshot.url}`,
            );
            return lastSnapshot;
        }

        if (isAuthenticatedShell(lastSnapshot)) {
            console.log(
                `ℹ️ Authenticated Nextdoor shell loaded during ${phase}; ` +
                `waiting for the scraper-ready controls...`,
            );
        }

        await sleep(2_500);
    }

    logDiagnostics(lastSnapshot, attempt, phase);
    return null;
}

async function closeOtherPages(context, keepPage) {
    const stalePages = context
        .pages()
        .filter((page) => page !== keepPage && !page.isClosed());

    for (const stalePage of stalePages) {
        await stalePage.close().catch(() => {});
    }

    if (stalePages.length) {
        console.log(
            `🧹 Closed ${stalePages.length} stale Multilogin tab(s).`,
        );
        await sleep(1_000);
    }
}

async function navigate(page, url, label) {
    console.log(`🧭 ${label}: ${url}`);

    await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
    });

    await sleep(5_000);
}

async function main() {
    const ws = process.env.MULTILOGIN_WS;

    if (!ws) {
        throw new Error("MULTILOGIN_WS is required");
    }

    console.log("🧪 Starting fresh Nextdoor browser preflight...");

    const browser = await chromium.connectOverCDP(ws);
    const context = browser.contexts()[0];

    if (!context) {
        throw new Error("No Multilogin browser context found.");
    }

    for (let attempt = 1; attempt <= 2; attempt += 1) {
        let page = null;

        try {
            console.log(`🔁 Nextdoor preflight attempt ${attempt}/2`);

            page = await context.newPage();
            page.setDefaultTimeout(30_000);
            page.setDefaultNavigationTimeout(60_000);

            // Multilogin persists tabs between scheduled runs. Start from one
            // brand-new page so yesterday's search/detail page cannot poison
            // today's readiness check.
            await closeOtherPages(context, page);

            await navigate(
                page,
                "https://nextdoor.com/news_feed/",
                "Opening fresh Nextdoor news feed",
            );

            let ready = await waitForStrictReady(
                page,
                35_000,
                attempt,
                "news feed",
            );

            if (!ready) {
                console.log(
                    "🛍️ News feed shell loaded without the expected controls; " +
                    "trying the marketplace landing page once.",
                );

                await navigate(
                    page,
                    "https://nextdoor.com/for_sale_and_free/",
                    "Opening fresh For Sale & Free page",
                );

                ready = await waitForStrictReady(
                    page,
                    35_000,
                    attempt,
                    "marketplace",
                );
            }

            if (ready) {
                console.log(
                    "✅ Nextdoor preflight complete. Leaving the verified tab " +
                    "open for index.js.",
                );
                return;
            }
        } catch (error) {
            const snapshot = page && !page.isClosed()
                ? await getReadinessSnapshot(page).catch(() => null)
                : null;

            if (snapshot) {
                logDiagnostics(snapshot, attempt, "exception");
            }

            console.error(
                `⚠️ Nextdoor preflight attempt ${attempt}/2 failed: ` +
                `${error?.message || String(error)}`,
            );
        }

        if (page && !page.isClosed()) {
            await page.close().catch(() => {});
        }

        if (attempt < 2) {
            console.log(
                "🔁 Replacing the failed page and retrying with a brand-new tab...",
            );
            await sleep(2_000);
        }
    }

    throw new Error(
        "Nextdoor preflight failed after two fresh-page attempts.",
    );
}

main()
    .then(() => {
        // Do not call browser.close(): this process is attached to the remote
        // Multilogin browser. Exiting only drops this CDP client connection and
        // leaves the verified page/profile running for index.js.
        process.exit(0);
    })
    .catch((error) => {
        console.error(
            "❌ Nextdoor browser preflight failed:",
            error?.stack || error,
        );
        process.exit(1);
    });
