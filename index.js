#!/usr/bin/env node
"use strict";

require("dotenv").config();

const { randomUUID } = require("crypto");
const { chromium } = require("playwright-core");
const pool = require("./db/db");
const normalizeCity = require("./normalizeCity");

const TABLE_NAME =
    "unfiltered_ins_mold_pest_housecl_plumb_paint_land_lawn_handy";

const SEARCH_RUNS_TABLE = "special_search_runs";
const SEARCH_TERM_RUNS_TABLE = "special_search_term_runs";
const SEARCH_RESULTS_TABLE = "special_search_results";

const ENRICHMENT_ENDPOINT_PATH = "/run";
const CRM_API_BASE_URL =
    process.env.CRM_API_BASE_URL ||
    "http://ftn-enrichment.railway.internal:8080";

const FALLBACK_STATE = process.env.FALLBACK_STATE || "TX";

const STANDARD_DISTANCE_MILES = Math.max(
    1,
    Number(process.env.STANDARD_DISTANCE_MILES || 15),
);

const BOOKKEEPING_DISTANCE_MILES = Math.max(
    STANDARD_DISTANCE_MILES,
    Number(process.env.BOOKKEEPING_DISTANCE_MILES || 50),
);

const MAX_POSTS_PER_TERM = Math.max(
    1,
    Number(process.env.SPECIAL_MAX_POSTS_PER_TERM || 50),
);

const REALTOR_MAX_LISTINGS = Math.max(
    1,
    Number(process.env.REALTOR_MAX_LISTINGS || 50),
);

const SEARCH_PAGE_MAX_ATTEMPTS = Math.max(
    1,
    Number(process.env.SEARCH_PAGE_MAX_ATTEMPTS || 3),
);

const DETAIL_PAGE_MAX_ATTEMPTS = Math.max(
    1,
    Number(process.env.DETAIL_PAGE_MAX_ATTEMPTS || 2),
);

const SEARCH_READY_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.SEARCH_READY_TIMEOUT_MS || 25_000),
);

const PAGE_DEFAULT_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.PAGE_DEFAULT_TIMEOUT_MS || 30_000),
);

const PAGE_NAVIGATION_TIMEOUT_MS = Math.max(
    20_000,
    Number(process.env.PAGE_NAVIGATION_TIMEOUT_MS || 60_000),
);

const RUN_REALTOR = !/^false$/i.test(process.env.RUN_REALTOR || "true");
const RUN_OUTDOOR_LIGHTING = !/^false$/i.test(
    process.env.RUN_OUTDOOR_LIGHTING || "true",
);
const RUN_BOOKKEEPING = !/^false$/i.test(
    process.env.RUN_BOOKKEEPING || "true",
);

const REALTOR_SEARCH_TERM = "by owner / Home sales";
const REALTOR_SEARCH_TEXT = "by owner";
const REALTOR_CATEGORY_TEXT = "Home sales";

const STANDARD_SEARCH_TERM_LEAD_TYPES = {
    // Outdoor lighting
    lights: ["outdoor_lighting"],
    "outdoor lighting": ["outdoor_lighting"],

    // Bookkeeping — broad learning terms
    bookkeeper: ["bookkeeper"],
    bookkeeping: ["bookkeeper"],
    accountant: ["bookkeeper"],
    quickbooks: ["bookkeeper"],
    "tax help": ["bookkeeper"],
    "payroll help": ["bookkeeper"],

    // Bookkeeping — higher-intent terms
    "looking for a bookkeeper": ["bookkeeper"],
    "looking for an accountant": ["bookkeeper"],
    "looking for a cpa": ["bookkeeper"],
    "tax accountant": ["bookkeeper"],
    "cpa recommendation": ["bookkeeper"],
    "quickbooks help": ["bookkeeper"],
    "quickbooks troubleshooting": ["bookkeeper"],
    "quickbooks cleanup": ["bookkeeper"],
    "irs help": ["bookkeeper"],
    "back taxes": ["bookkeeper"],
    "tax preparation": ["bookkeeper"],
};

const BOOKKEEPING_SEARCH_TERMS = new Set([
    // Broad learning terms
    "bookkeeper",
    "bookkeeping",
    "accountant",
    "quickbooks",
    "tax help",
    "payroll help",

    // Higher-intent terms
    "looking for a bookkeeper",
    "looking for an accountant",
    "looking for a cpa",
    "tax accountant",
    "cpa recommendation",
    "quickbooks help",
    "quickbooks troubleshooting",
    "quickbooks cleanup",
    "irs help",
    "back taxes",
    "tax preparation",
]);

const OUTDOOR_LIGHTING_SEARCH_TERMS = new Set([
    "lights",
    "outdoor lighting",
]);

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

const BLOCKED_REQUEST_URL_PATTERN =
    /(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|2mdn\.net|amazon-adsystem\.com|adnxs\.com|adsystem\.com|simgad)/i;

const IGNORED_PAGE_ERROR_PATTERN =
    /(?:A network error occurred|Failed to load:|Failed to fetch|buildAdSlot is not defined|buildGlaurungAds is not defined|adSlot is not defined|Class extends value undefined|_\.t is not a function)/i;

const TARGET_CRASH_PATTERN =
    /page crashed|target crashed|renderer process crashed/i;

const BROWSER_DISCONNECTED_PATTERN =
    /browser.*disconnected|browser has been closed|connection closed|websocket.*closed/i;

let browserDisconnected = false;
let asynchronousTargetCrashCount = 0;

const sleep = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

function cleanText(value = "") {
    return String(value).replace(/\s+/g, " ").trim();
}

function envEnabled(value, fallback = true) {
    if (value == null || value === "") return fallback;
    return !/^(0|false|no|off)$/i.test(String(value));
}

function getErrorMessage(error) {
    return error?.message || String(error || "Unknown error");
}

function isTargetCrashError(error) {
    return TARGET_CRASH_PATTERN.test(getErrorMessage(error));
}

function isBrowserDisconnectedError(error) {
    return BROWSER_DISCONNECTED_PATTERN.test(getErrorMessage(error));
}

function isRetryablePageError(error) {
    const message = getErrorMessage(error);

    return (
        isTargetCrashError(error) ||
        /target page, context or browser has been closed/i.test(message) ||
        /navigation failed|net::err_|timeout/i.test(message)
    );
}

function normalizeRecordUrl(url) {
    try {
        const parsed = new URL(url);
        const postId =
            parsed.pathname.match(/\/(?:p|posting)\/([^/?#]+)/i)?.[1];

        if (postId) {
            return `https://nextdoor.com/p/${postId}`;
        }

        // Marketplace/listing URLs may use their own path format. Keep that
        // canonical path while dropping transient tracking query parameters.
        return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
    } catch {
        return url;
    }
}

function parseExplicitLocation(location = "") {
    const clean = cleanText(location);
    const match = clean.match(/^(.+?),\s*([A-Z]{2})(?:\b|\s|$)/i);

    return match
        ? {
            city: match[1].trim(),
            state: match[2].trim().toUpperCase(),
        }
        : {
            city: clean || null,
            state: null,
        };
}

async function resolveCityState({ location, description }) {
    const explicit = parseExplicitLocation(location);

    try {
        const normalized = await normalizeCity({
            city: explicit.city,
            state: explicit.state || FALLBACK_STATE,
            location,
            description,
        });

        return {
            city: normalized?.city || explicit.city || null,
            state:
                normalized?.state ||
                explicit.state ||
                FALLBACK_STATE ||
                null,
        };
    } catch (error) {
        console.warn(
            `⚠️ normalizeCity failed for "${location}": ${getErrorMessage(error)}`,
        );

        return {
            city: explicit.city || null,
            state: explicit.state || FALLBACK_STATE || null,
        };
    }
}

function getSearchDistance(query) {
    const normalized = cleanText(query).toLowerCase();

    return BOOKKEEPING_SEARCH_TERMS.has(normalized)
        ? BOOKKEEPING_DISTANCE_MILES
        : STANDARD_DISTANCE_MILES;
}

function getSourceKind(query) {
    const normalized = cleanText(query).toLowerCase();

    if (BOOKKEEPING_SEARCH_TERMS.has(normalized)) {
        return "bookkeeping";
    }

    if (OUTDOOR_LIGHTING_SEARCH_TERMS.has(normalized)) {
        return "outdoor_lighting";
    }

    return "standard";
}

function buildStandardSearchPlan() {
    const plan = [];

    if (RUN_OUTDOOR_LIGHTING) {
        plan.push("lights", "outdoor lighting");
    }

    if (RUN_BOOKKEEPING) {
        plan.push(
            "bookkeeper",
            "bookkeeping",
            "accountant",
            "quickbooks",
            "tax help",
            "payroll help",
        );
    }

    return plan;
}

async function configurePage(page, label) {
    page.setDefaultTimeout(PAGE_DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(PAGE_NAVIGATION_TIMEOUT_MS);

    let suppressedPageErrors = 0;

    page.on("crash", () => {
        console.error(`💥 Chromium page crashed (${label}).`);
    });

    page.on("pageerror", (error) => {
        const message = getErrorMessage(error);

        if (IGNORED_PAGE_ERROR_PATTERN.test(message)) {
            suppressedPageErrors += 1;
            return;
        }

        console.warn(`⚠️ Page JavaScript error (${label}): ${message}`);
    });

    page.on("close", () => {
        if (suppressedPageErrors > 0) {
            console.log(
                `ℹ️ Suppressed ${suppressedPageErrors} harmless ` +
                `network/ad page error(s) for ${label}.`,
            );
        }
    });

    await page.route("**/*", async (route) => {
        const request = route.request();
        const resourceType = request.resourceType();
        const requestUrl = request.url();

        if (
            BLOCKED_RESOURCE_TYPES.has(resourceType) ||
            BLOCKED_REQUEST_URL_PATTERN.test(requestUrl)
        ) {
            await route.abort().catch(() => {});
            return;
        }

        await route.continue().catch(() => {});
    });

    return page;
}

async function createConfiguredPage(context, label) {
    const page = await context.newPage();
    return configurePage(page, label);
}

async function closePageSafely(page, label) {
    if (!page || page.isClosed()) return;

    await page.close().catch((error) => {
        console.warn(
            `⚠️ Could not close ${label}: ${getErrorMessage(error)}`,
        );
    });

    await sleep(500);
}

async function closeStaleContextPages(context, keepPage) {
    const stalePages = context
        .pages()
        .filter((page) => page !== keepPage && !page.isClosed());

    for (let index = 0; index < stalePages.length; index += 1) {
        await stalePages[index].close().catch(() => {});
    }

    if (stalePages.length) {
        console.log(`🧹 Closed ${stalePages.length} stale browser page(s).`);
        await sleep(1_500);
    }
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

async function findVisibleSearchBox(page) {
    return firstVisible([
        page.locator('input[aria-label="Search Nextdoor"]'),
        page.locator('input[placeholder*="Search Nextdoor" i]'),
        page.locator('input[type="search"]'),
        page.locator('[data-testid="search-input"] input'),
    ]);
}

async function getCurrentNextdoorPage(context) {
    const pages = context.pages().filter((page) => !page.isClosed());

    return (
        pages.find((page) => /nextdoor\.com/i.test(page.url())) ||
        pages[0] ||
        context.newPage()
    );
}

async function waitForNextdoorReady(
    context,
    totalMs = 180_000,
) {
    console.log(
        "⏳ Waiting for the Multilogin profile and Nextdoor to finish loading...",
    );

    const deadline = Date.now() + totalMs;

    let page = null;
    let forcedFeedNavigation = false;
    let forcedReload = false;
    let hydratingStartedAt = null;

    await sleep(7_000);

    while (Date.now() < deadline) {
        const remaining = Math.max(
            0,
            Math.round((deadline - Date.now()) / 1000),
        );

        page = await getCurrentNextdoorPage(context);

        if (!page || page.isClosed()) {
            console.log(
                `   ⏱ No usable page yet. ${remaining}s remaining...`,
            );

            await sleep(2_500);
            continue;
        }

        const url = page.url();

        console.log(
            `   ⏱ ${remaining}s remaining | ${url}`,
        );

        const isNextdoor =
            /(^https?:\/\/)?([^/]+\.)?nextdoor\.com/i.test(url);

        if (!isNextdoor) {
            if (!forcedFeedNavigation) {
                forcedFeedNavigation = true;

                console.log(
                    "🧭 Current page is not Nextdoor. Opening news feed...",
                );

                await page
                    .goto(
                        "https://nextdoor.com/news_feed/",
                        {
                            waitUntil: "domcontentloaded",
                            timeout: 60_000,
                        },
                    )
                    .catch((error) => {
                        console.log(
                            `ℹ️ Feed navigation still settling: ${error.message}`,
                        );
                    });

                await sleep(5_000);
                continue;
            }

            await sleep(2_500);
            continue;
        }

        const isLoginOrInterstitial =
            /\/(login|verify|choose_address|checkpoint)/i.test(
                url,
            );

        if (isLoginOrInterstitial) {
            console.log(
                `ℹ️ Waiting on Nextdoor login/interstitial: ${url}`,
            );

            hydratingStartedAt = null;

            await sleep(2_500);
            continue;
        }

        // ---------------------------------------------------------
        // NORMAL POSTS SEARCH READY
        // ---------------------------------------------------------

        const searchBox =
            await findVisibleSearchBox(page);

        if (searchBox) {
            console.log(
                `✅ Nextdoor is ready — search box found: ${url}`,
            );

            return page;
        }

        // ---------------------------------------------------------
        // REALTOR MARKETPLACE READY
        // ---------------------------------------------------------

        const forSaleAndFree =
            await firstVisible([
                page.getByText(
                    "For Sale & Free",
                    { exact: true },
                ),

                page.locator(
                    'span[data-block="33"]',
                    {
                        hasText:
                            "For Sale & Free",
                    },
                ),

                page.getByRole(
                    "link",
                    {
                        name:
                            /For Sale & Free/i,
                    },
                ),

                page.getByRole(
                    "button",
                    {
                        name:
                            /For Sale & Free/i,
                    },
                ),

                page.locator(
                    'text="For Sale & Free"',
                ),
            ]);

        if (forSaleAndFree) {
            console.log(
                `✅ Nextdoor is ready — For Sale & Free found: ${url}`,
            );

            return page;
        }

        // ---------------------------------------------------------
        // PAGE APPEARS OPEN BUT STILL HYDRATING
        // ---------------------------------------------------------

        if (!hydratingStartedAt) {
            hydratingStartedAt = Date.now();
        }

        const hydratingForMs =
            Date.now() - hydratingStartedAt;

        if (
            !forcedFeedNavigation &&
            hydratingForMs >= 15_000
        ) {
            forcedFeedNavigation = true;

            console.log(
                "🧭 Nextdoor is open but not ready. Opening a clean news feed...",
            );

            await page
                .goto(
                    "https://nextdoor.com/news_feed/",
                    {
                        waitUntil: "domcontentloaded",
                        timeout: 60_000,
                    },
                )
                .catch((error) => {
                    console.log(
                        `ℹ️ Forced navigation still settling: ${error.message}`,
                    );
                });

            hydratingStartedAt = Date.now();

            await sleep(7_000);
            continue;
        }

        // ---------------------------------------------------------
        // CLEAN FEED STILL DIDN'T HYDRATE — RELOAD ONCE
        // ---------------------------------------------------------

        if (
            forcedFeedNavigation &&
            !forcedReload &&
            hydratingForMs >= 45_000
        ) {
            forcedReload = true;

            console.log(
                "🔄 Nextdoor still isn't ready. Reloading once...",
            );

            await page
                .reload({
                    waitUntil: "domcontentloaded",
                    timeout: 60_000,
                })
                .catch((error) => {
                    console.log(
                        `ℹ️ Reload still settling: ${error.message}`,
                    );
                });

            hydratingStartedAt = Date.now();

            await sleep(7_000);
            continue;
        }

        await sleep(2_500);
    }

    throw new Error(
        "Nextdoor did not become ready before timeout.",
    );
}
async function expandSeeMore(page) {
    const buttons = page.locator(
        'button:has-text("See more"), [data-testid="see-more-text"]',
    );

    const count = Math.min(await buttons.count().catch(() => 0), 4);

    for (let index = 0; index < count; index += 1) {
        try {
            if (await buttons.nth(index).isVisible()) {
                await buttons.nth(index).click({ timeout: 1_200 });
                await sleep(250);
            }
        } catch {}
    }
}

async function extractAuthor(page) {
    const selectors = [
        'a[href*="/profile/"][href*="detail_author"]',
        'a[href*="/profile/"][href*="is=detail_author"]',
        'main article a[href*="/profile/"]',
        'a[href*="/profile/"]',
    ];

    for (const selector of selectors) {
        const links = page.locator(selector);
        const count = Math.min(await links.count().catch(() => 0), 20);

        for (let index = 0; index < count; index += 1) {
            try {
                const link = links.nth(index);
                const text = cleanText(await link.innerText());

                if (
                    /^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+){1,5}$/.test(
                        text,
                    )
                ) {
                    return text;
                }

                const aria = await link
                    .locator('[aria-label*="Avatar for" i]')
                    .first()
                    .getAttribute("aria-label")
                    .catch(() => null);

                if (aria) {
                    return cleanText(aria.replace(/^Avatar for\s*/i, ""));
                }
            } catch {}
        }
    }

    return null;
}

async function insertUnfilteredRecord(record) {
    const query = `
        INSERT INTO ${TABLE_NAME}
        (
            author,
            location,
            description,
            post_url,
            city,
            state,
            lead_type,
            timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::text[], NOW())
        ON CONFLICT (post_url) DO UPDATE SET
            author = COALESCE(EXCLUDED.author, ${TABLE_NAME}.author),
            location = COALESCE(EXCLUDED.location, ${TABLE_NAME}.location),
            description = COALESCE(EXCLUDED.description, ${TABLE_NAME}.description),
            city = COALESCE(EXCLUDED.city, ${TABLE_NAME}.city),
            state = COALESCE(EXCLUDED.state, ${TABLE_NAME}.state),
            lead_type = ARRAY(
                SELECT DISTINCT value
                FROM unnest(
                    COALESCE(${TABLE_NAME}.lead_type, ARRAY[]::text[]) ||
                    COALESCE(EXCLUDED.lead_type, ARRAY[]::text[])
                ) AS value
                WHERE value IS NOT NULL
                  AND BTRIM(value) <> ''
            )
        RETURNING id
    `;

    const { rows } = await pool.query(query, [
        record.author,
        record.location,
        record.description,
        normalizeRecordUrl(record.post_url),
        record.city,
        record.state,
        Array.isArray(record.lead_type)
            ? record.lead_type
            : [record.lead_type],
    ]);

    const id = rows[0]?.id || null;

    console.log(
        `✅ Saved: ${record.author || "(unknown)"} → ` +
        `${record.city || "(unknown city)"}, ${record.state || "(unknown state)"}` +
        `${id ? ` (id=${id})` : ""}`,
    );

    return id;
}

async function getExistingUrls(items) {
    const urls = items
        .map((item) => normalizeRecordUrl(item.url || item.post_url))
        .filter(Boolean);

    if (!urls.length) return new Set();

    const { rows } = await pool.query(
        `
            SELECT post_url
            FROM ${TABLE_NAME}
            WHERE post_url = ANY($1::text[])
        `,
        [urls],
    );

    return new Set(rows.map((row) => normalizeRecordUrl(row.post_url)));
}

async function ensureAuditTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${SEARCH_RUNS_TABLE} (
            run_id uuid PRIMARY KEY,
            started_at timestamptz NOT NULL DEFAULT NOW(),
            completed_at timestamptz,
            status text NOT NULL DEFAULT 'running',
            planned_search_terms integer NOT NULL DEFAULT 0,
            total_result_observations integer NOT NULL DEFAULT 0,
            total_unique_result_urls integer NOT NULL DEFAULT 0,
            total_existing_posts integer NOT NULL DEFAULT 0,
            total_cross_term_duplicates integer NOT NULL DEFAULT 0,
            total_new_candidates integer NOT NULL DEFAULT 0,
            total_inserted integer NOT NULL DEFAULT 0,
            total_failed integer NOT NULL DEFAULT 0,
            run_error text
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${SEARCH_TERM_RUNS_TABLE} (
            run_id uuid NOT NULL REFERENCES ${SEARCH_RUNS_TABLE}(run_id) ON DELETE CASCADE,
            search_term text NOT NULL,
            source_kind text NOT NULL,
            expected_lead_types text[] NOT NULL DEFAULT ARRAY[]::text[],
            distance_miles integer,
            date_filter text,
            observations integer NOT NULL DEFAULT 0,
            unique_posts integer NOT NULL DEFAULT 0,
            existing_posts integer NOT NULL DEFAULT 0,
            cross_term_duplicates integer NOT NULL DEFAULT 0,
            fresh_candidates integer NOT NULL DEFAULT 0,
            inserted integer NOT NULL DEFAULT 0,
            failed integer NOT NULL DEFAULT 0,
            started_at timestamptz NOT NULL DEFAULT NOW(),
            completed_at timestamptz,
            PRIMARY KEY (run_id, search_term)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${SEARCH_RESULTS_TABLE} (
            id bigserial PRIMARY KEY,
            run_id uuid NOT NULL REFERENCES ${SEARCH_RUNS_TABLE}(run_id) ON DELETE CASCADE,
            search_term text NOT NULL,
            source_kind text NOT NULL,
            expected_lead_types text[] NOT NULL DEFAULT ARRAY[]::text[],
            result_position integer,
            post_url text NOT NULL,
            preview text,
            was_existing boolean NOT NULL DEFAULT false,
            cross_term_duplicate boolean NOT NULL DEFAULT false,
            inserted_new boolean NOT NULL DEFAULT false,
            inserted_lead_id bigint,
            scraper_error text,
            created_at timestamptz NOT NULL DEFAULT NOW(),
            expires_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '35 days'),
            UNIQUE (run_id, search_term, post_url)
        )
    `);
}

async function purgeExpiredSearchHistory() {
    await pool.query(
        `DELETE FROM ${SEARCH_RESULTS_TABLE} WHERE expires_at < NOW()`,
    );

    await pool.query(`
        DELETE FROM ${SEARCH_RUNS_TABLE}
        WHERE started_at < NOW() - INTERVAL '35 days'
    `);
}

async function createSearchRun(runId, plannedSearchTerms) {
    await pool.query(
        `
            INSERT INTO ${SEARCH_RUNS_TABLE}
                (run_id, status, planned_search_terms)
            VALUES ($1, 'running', $2)
            ON CONFLICT (run_id) DO NOTHING
        `,
        [runId, plannedSearchTerms],
    );
}

async function finishSearchRun(runId, status, totals, error = null) {
    await pool.query(
        `
            UPDATE ${SEARCH_RUNS_TABLE}
            SET
                completed_at = NOW(),
                status = $2,
                total_result_observations = $3,
                total_unique_result_urls = $4,
                total_existing_posts = $5,
                total_cross_term_duplicates = $6,
                total_new_candidates = $7,
                total_inserted = $8,
                total_failed = $9,
                run_error = $10
            WHERE run_id = $1
        `,
        [
            runId,
            status,
            totals.resultObservations || 0,
            totals.uniqueResultUrls || 0,
            totals.existingSkipped || 0,
            totals.crossTermSkipped || 0,
            totals.newCandidates || 0,
            totals.inserted || 0,
            totals.failed || 0,
            error ? String(error).slice(0, 4_000) : null,
        ],
    );
}

async function startTermAudit({
    runId,
    searchTerm,
    sourceKind,
    expectedLeadTypes,
    distanceMiles,
    dateFilter,
}) {
    await pool.query(
        `
            INSERT INTO ${SEARCH_TERM_RUNS_TABLE}
            (
                run_id,
                search_term,
                source_kind,
                expected_lead_types,
                distance_miles,
                date_filter
            )
            VALUES ($1, $2, $3, $4::text[], $5, $6)
            ON CONFLICT (run_id, search_term)
            DO UPDATE SET
                source_kind = EXCLUDED.source_kind,
                expected_lead_types = EXCLUDED.expected_lead_types,
                distance_miles = EXCLUDED.distance_miles,
                date_filter = EXCLUDED.date_filter
        `,
        [
            runId,
            searchTerm,
            sourceKind,
            expectedLeadTypes,
            distanceMiles,
            dateFilter,
        ],
    );
}

async function finishTermAudit(runId, searchTerm, stats) {
    await pool.query(
        `
            UPDATE ${SEARCH_TERM_RUNS_TABLE}
            SET
                observations = $3,
                unique_posts = $4,
                existing_posts = $5,
                cross_term_duplicates = $6,
                fresh_candidates = $7,
                inserted = $8,
                failed = $9,
                completed_at = NOW()
            WHERE run_id = $1
              AND search_term = $2
        `,
        [
            runId,
            searchTerm,
            stats.observations || 0,
            stats.uniquePosts || 0,
            stats.existingSkipped || 0,
            stats.crossTermSkipped || 0,
            stats.newCandidates || 0,
            stats.inserted || 0,
            stats.failed || 0,
        ],
    );
}

async function logSearchObservations({
    runId,
    searchTerm,
    sourceKind,
    expectedLeadTypes,
    items,
    existingUrls,
    crossTermUrls,
}) {
    if (!items.length) return 0;

    const values = [];
    const placeholders = [];

    items.forEach((item, index) => {
        const base = values.length;
        const url = normalizeRecordUrl(item.url || item.post_url);
        const preview = cleanText(
            item.preview || item.text || item.description || "",
        ).slice(0, 1_500);

        values.push(
            runId,
            searchTerm,
            sourceKind,
            expectedLeadTypes,
            index + 1,
            url,
            preview || null,
            existingUrls.has(url),
            crossTermUrls.has(url),
        );

        placeholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, ` +
            `$${base + 4}::text[], $${base + 5}, $${base + 6}, ` +
            `$${base + 7}, $${base + 8}, $${base + 9})`,
        );
    });

    await pool.query(
        `
            INSERT INTO ${SEARCH_RESULTS_TABLE}
            (
                run_id,
                search_term,
                source_kind,
                expected_lead_types,
                result_position,
                post_url,
                preview,
                was_existing,
                cross_term_duplicate
            )
            VALUES ${placeholders.join(",\n")}
            ON CONFLICT (run_id, search_term, post_url)
            DO UPDATE SET
                source_kind = EXCLUDED.source_kind,
                expected_lead_types = EXCLUDED.expected_lead_types,
                result_position = EXCLUDED.result_position,
                preview = EXCLUDED.preview,
                was_existing = EXCLUDED.was_existing,
                cross_term_duplicate = EXCLUDED.cross_term_duplicate
        `,
        values,
    );

    return items.length;
}

async function markAuditInserted(runId, searchTerm, url, leadId) {
    await pool.query(
        `
            UPDATE ${SEARCH_RESULTS_TABLE}
            SET inserted_new = TRUE,
                inserted_lead_id = $4,
                scraper_error = NULL
            WHERE run_id = $1
              AND search_term = $2
              AND post_url = $3
        `,
        [runId, searchTerm, normalizeRecordUrl(url), leadId],
    );
}

async function markAuditError(runId, searchTerm, url, error) {
    await pool.query(
        `
            UPDATE ${SEARCH_RESULTS_TABLE}
            SET scraper_error = $4
            WHERE run_id = $1
              AND search_term = $2
              AND post_url = $3
        `,
        [
            runId,
            searchTerm,
            normalizeRecordUrl(url),
            String(error || "unknown error").slice(0, 2_000),
        ],
    );
}

// ---------------------------------------------------------------------------
// Normal Posts-search flow: outdoor lighting + bookkeeping
// ---------------------------------------------------------------------------

async function goToPostsTab(page, query) {
    const candidate = await firstVisible([
        page.getByRole("tab", { name: /^Posts$/i }),
        page.locator('[data-testid="tab-posts"]'),
        page.locator("a,button").filter({ hasText: /^Posts$/i }),
    ]);

    if (candidate) {
        await candidate.click();
        await sleep(1_500);
        return;
    }

    await page.goto(
        `https://nextdoor.com/search/posts/?query=${encodeURIComponent(query)}`,
        {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
        },
    );

    await sleep(2_000);
}

async function applyMostRecentFilter(page) {
    const trigger = await firstVisible([
        page.locator('[aria-label="Sort By"]'),
        page.locator('div[role="button"][aria-label="Sort By"]'),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /^(Most Relevant|Most Recent)$/i }),
    ]);

    if (!trigger) return false;

    const currentText = cleanText(await trigger.innerText().catch(() => ""));
    if (/most recent/i.test(currentText)) return true;

    await trigger.click();
    await sleep(500);

    const option = await firstVisible([
        page.getByRole("menuitem", { name: /^Most Recent$/i }),
        page.getByRole("option", { name: /^Most Recent$/i }),
        page.getByText(/^Most Recent$/i),
    ]);

    if (!option) return false;

    await option.click();
    await sleep(1_000);
    return true;
}

async function applyDistanceFilter(page, targetMiles) {
    const exactLabel = new RegExp(`^${targetMiles}\\s*miles?$`, "i");

    const trigger = await firstVisible([
        page.getByRole("button", { name: /(?:\d+\s*miles?|distance)/i }),
        page
            .locator("button, [role=button]")
            .filter({ hasText: /\d+\s*miles?/i }),
    ]);

    if (!trigger) return false;

    const currentText = cleanText(await trigger.innerText().catch(() => ""));
    if (exactLabel.test(currentText)) return true;

    await trigger.click();
    await sleep(500);

    const option = await firstVisible([
        page.getByRole("menuitem", { name: exactLabel }),
        page.getByRole("option", { name: exactLabel }),
        page.getByText(exactLabel),
    ]);

    if (option) {
        await option.click();
        await sleep(1_000);
        return true;
    }

    const slider = page.locator('.rc-slider-handle[role="slider"]').first();

    if (
        (await slider.count().catch(() => 0)) &&
        (await slider.isVisible().catch(() => false))
    ) {
        await slider.focus();
        let current = Number(await slider.getAttribute("aria-valuenow"));
        if (!Number.isFinite(current)) current = 1;

        while (current > 1) {
            await page.keyboard.press("ArrowLeft");
            current -= 1;
        }

        for (let value = 1; value < targetMiles; value += 1) {
            await page.keyboard.press("ArrowRight");
        }

        await page.keyboard.press("Escape").catch(() => {});
        await sleep(800);
        return true;
    }

    return false;
}

async function applyTodayFilter(page) {
    const trigger = await firstVisible([
        page.getByRole("button", {
            name: /^(All Time|Today|This Week|This Month|This Year)$/i,
        }),
        page
            .locator("button, [role=button]")
            .filter({
                hasText: /^(All Time|Today|This Week|This Month|This Year)$/i,
            }),
    ]);

    if (!trigger) return false;

    const currentText = cleanText(await trigger.innerText().catch(() => ""));
    if (/^today$/i.test(currentText)) return true;

    await trigger.click();
    await sleep(500);

    const option = await firstVisible([
        page.getByRole("menuitem", { name: /^Today$/i }),
        page.getByRole("option", { name: /^Today$/i }),
        page.getByText(/^Today$/i),
    ]);

    if (!option) return false;

    await option.click();
    await sleep(1_000);
    return true;
}

async function applySearchFiltersByUrl(page, query) {
    const currentUrl = new URL(page.url());

    if (!/(^|\.)nextdoor\.com$/i.test(currentUrl.hostname)) {
        throw new Error(
            `Unexpected search URL before applying filters: ${page.url()}`,
        );
    }

    const targetMiles = getSearchDistance(query);

    currentUrl.searchParams.set("navigationScreen", "POST");
    currentUrl.searchParams.set("query", query);
    currentUrl.searchParams.set("postSortOrder", "SORT_BY_RECENCY");
    currentUrl.searchParams.set("postDistance", String(targetMiles));
    currentUrl.searchParams.set("postDistanceUnit", "MILES");
    currentUrl.searchParams.set("postDateFilter", "TODAY");

    const targetUrl = currentUrl.toString();

    console.log("🔗 Applying search filters through the URL:");
    console.log(`   Posts + Most Recent + ${targetMiles} miles + Today`);
    console.log(`   ${targetUrl}`);

    await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
    });

    await sleep(3_500);

    const appliedUrl = new URL(page.url());
    const applied = {
        navigationScreen: appliedUrl.searchParams.get("navigationScreen"),
        query: appliedUrl.searchParams.get("query"),
        postSortOrder: appliedUrl.searchParams.get("postSortOrder"),
        postDistance: appliedUrl.searchParams.get("postDistance"),
        postDistanceUnit: appliedUrl.searchParams.get("postDistanceUnit"),
        postDateFilter: appliedUrl.searchParams.get("postDateFilter"),
    };

    console.log("✅ URL filter state:", applied);

    const filtersAreCorrect =
        applied.navigationScreen === "POST" &&
        applied.query === query &&
        applied.postSortOrder === "SORT_BY_RECENCY" &&
        applied.postDistance === String(targetMiles) &&
        applied.postDistanceUnit === "MILES" &&
        applied.postDateFilter === "TODAY";

    if (!filtersAreCorrect) {
        throw new Error(
            "Nextdoor removed or changed one or more URL filter parameters.",
        );
    }
}

async function searchNextdoorPosts(page, query) {
    console.log("");
    console.log("============================================================");
    console.log(`🔍 Searching Nextdoor Posts for "${query}"...`);
    console.log("============================================================");

    await page.goto("https://nextdoor.com/news_feed/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
    });

    await sleep(2_500);

    let searchBox = await findVisibleSearchBox(page);

    if (!searchBox) {
        const deadline = Date.now() + SEARCH_READY_TIMEOUT_MS;

        while (Date.now() < deadline && !searchBox) {
            await sleep(1_500);
            searchBox = await findVisibleSearchBox(page);
        }
    }

    if (!searchBox) {
        throw new Error("Could not find the Nextdoor search bar.");
    }

    await searchBox.click();
    await searchBox.fill(query);
    await page.keyboard.press("Enter");
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(3_000);

    try {
        await applySearchFiltersByUrl(page, query);
    } catch (error) {
        console.warn(`⚠️ URL filters failed: ${getErrorMessage(error)}`);
        console.log("♻️ Falling back to visible Posts/filter controls...");

        await goToPostsTab(page, query);
        await applyMostRecentFilter(page);
        await applyDistanceFilter(page, getSearchDistance(query));
        await applyTodayFilter(page);
        await sleep(1_800);
    }
}

async function collectPostLinks(page, limit = MAX_POSTS_PER_TERM) {
    console.log("⬇️ Loading search results...");

    let previousCount = -1;
    let stablePasses = 0;

    for (let pass = 1; pass <= 20; pass += 1) {
        const count = await page
            .locator('a[href*="/p/"], a[href*="/posting/"]')
            .count();

        console.log(`   pass ${pass}: ${count} links loaded`);

        stablePasses = count === previousCount ? stablePasses + 1 : 0;
        previousCount = count;

        if (stablePasses >= 4) break;

        await page.mouse.wheel(0, 1_700);
        await sleep(900);
    }

    const raw = await page.evaluate((maxResults) => {
        const clean = (value = "") =>
            String(value).replace(/\s+/g, " ").trim();

        const results = [];
        const seen = new Set();
        const anchors = document.querySelectorAll(
            'a[href*="/p/"], a[href*="/posting/"]',
        );

        for (const anchor of anchors) {
            const href = anchor.href;
            if (!href || seen.has(href)) continue;

            const primaryAvatar = anchor.querySelector(
                '[data-testid="search-result-image"]',
            );

            // Prefer the authoritative primary search card when available.
            if (primaryAvatar) {
                let author = null;
                const avatarLabel =
                    primaryAvatar.getAttribute("aria-label") || "";
                const avatarMatch = avatarLabel.match(/^Avatar for\s+(.+)$/i);
                if (avatarMatch) author = clean(avatarMatch[1]);

                let location = null;
                const styledTexts = [
                    ...anchor.querySelectorAll('[data-testid="styled-text"]'),
                ]
                    .map((element) => clean(element.textContent))
                    .filter(Boolean);

                for (const text of styledTexts) {
                    const match = text.match(/^(.+?),\s*([A-Z]{2})\s*·\s*/i);
                    if (match) {
                        location = `${clean(match[1])}, ${match[2].toUpperCase()}`;
                        break;
                    }
                }

                let preview = "";
                const bodyWrappers = [
                    ...anchor.querySelectorAll(
                        '[data-testid="styled-text-wrapper"]',
                    ),
                ];

                for (const wrapper of bodyWrappers) {
                    const text = clean(wrapper.textContent);
                    if (
                        text.length > preview.length &&
                        text !== author &&
                        !/^.+,\s*[A-Z]{2}\s*·/i.test(text)
                    ) {
                        preview = text;
                    }
                }

                if (preview.length < 15) {
                    preview = clean(anchor.innerText);
                }

                if (preview.length >= 15) {
                    seen.add(href);
                    results.push({
                        url: href,
                        preview: preview.slice(0, 1_500),
                        author: author || null,
                        location: location || null,
                    });
                }
            } else {
                // Fallback for Nextdoor DOM changes.
                const root =
                    anchor.closest("article, [role=article], li") || anchor;
                const preview = clean(root.innerText || anchor.innerText || "");

                if (preview.length >= 15) {
                    seen.add(href);
                    results.push({
                        url: href,
                        preview: preview.slice(0, 1_500),
                        author: null,
                        location: null,
                    });
                }
            }

            if (results.length >= maxResults) break;
        }

        return results;
    }, limit);

    const unique = new Map();

    for (const post of raw) {
        const url = normalizeRecordUrl(post.url);
        if (!unique.has(url)) unique.set(url, { ...post, url });
    }

    const posts = [...unique.values()];
    console.log(`🔗 Found ${posts.length} unique post(s).`);
    return posts;
}

async function extractPostDetails(detailPage, post, searchTerm) {
    const url = normalizeRecordUrl(post.url);

    await detailPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
    });

    await sleep(1_400);
    await expandSeeMore(detailPage);

    const author = post.author || (await extractAuthor(detailPage));

    const extracted = await detailPage.evaluate(({ preview }) => {
        const clean = (value) =>
            (value || "").replace(/\s+/g, " ").trim();

        const junk =
            /Home For Sale & Free Local News Ask Alerts Groups Events Post Settings Help Center/i;

        const tokens = clean(preview)
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length >= 4);

        const tokenSet = new Set(tokens.slice(0, 80));
        const candidates = [];

        const selectors = [
            '[data-testid="post-body-text"]',
            '[data-testid="styled-text-wrapper"]',
            'span[data-testid="styled-text"]',
            ".postTextBodySpan",
            'main [dir="auto"]',
        ];

        for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
                const text = clean(element.innerText || element.textContent);

                if (
                    text.length < 20 ||
                    text.length > 7_000 ||
                    junk.test(text)
                ) {
                    continue;
                }

                const words = text.toLowerCase().split(/[^a-z0-9]+/);
                const overlap = words.reduce(
                    (total, word) => total + (tokenSet.has(word) ? 1 : 0),
                    0,
                );

                candidates.push({
                    text,
                    score: overlap * 100 + Math.min(text.length, 1_500),
                });
            }
        }

        candidates.sort((a, b) => b.score - a.score);

        let location = null;
        const bodyLines = document.body.innerText
            .split("\n")
            .map(clean)
            .filter(Boolean);

        const explicit = bodyLines.find((line) =>
            /^[A-Za-z .'-]+,\s*[A-Z]{2}(?:\b|\s|$)/.test(line),
        );

        if (explicit) location = explicit;

        return {
            description: candidates[0]?.text || clean(preview) || null,
            location,
        };
    }, { preview: post.preview });

    const description = cleanText(extracted.description || post.preview);
    const location = cleanText(post.location || extracted.location || "");
    const cityState = await resolveCityState({ location, description });

    return {
        author,
        location: location || null,
        description,
        post_url: url,
        city: cityState.city,
        state: cityState.state,
        lead_type: STANDARD_SEARCH_TERM_LEAD_TYPES[searchTerm] || [],
        search_term: searchTerm,
    };
}

async function collectPostsForSearchTerm(context, query) {
    let lastError = null;

    for (let attempt = 1; attempt <= SEARCH_PAGE_MAX_ATTEMPTS; attempt += 1) {
        let page = null;
        const crashCountAtStart = asynchronousTargetCrashCount;

        try {
            page = await createConfiguredPage(
                context,
                `search:${query}:attempt:${attempt}`,
            );

            await searchNextdoorPosts(page, query);
            const posts = await collectPostLinks(page, MAX_POSTS_PER_TERM);

            if (asynchronousTargetCrashCount > crashCountAtStart) {
                throw new Error(`Target crashed while searching for "${query}".`);
            }

            return posts;
        } catch (error) {
            lastError = error;

            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw error;
            }

            console.error(
                `❌ Search attempt ${attempt}/${SEARCH_PAGE_MAX_ATTEMPTS} ` +
                `failed for "${query}": ${getErrorMessage(error)}`,
            );

            if (attempt < SEARCH_PAGE_MAX_ATTEMPTS) {
                await sleep(attempt * 2_000);
            }
        } finally {
            await closePageSafely(page, `search page for "${query}"`);
        }
    }

    throw lastError || new Error(`Search failed for "${query}".`);
}

async function extractPostDetailsWithFreshPage(context, post, searchTerm) {
    let lastError = null;

    for (let attempt = 1; attempt <= DETAIL_PAGE_MAX_ATTEMPTS; attempt += 1) {
        let detailPage = null;
        const crashCountAtStart = asynchronousTargetCrashCount;

        try {
            detailPage = await createConfiguredPage(
                context,
                `detail:${searchTerm}:attempt:${attempt}`,
            );

            const record = await extractPostDetails(
                detailPage,
                post,
                searchTerm,
            );

            if (asynchronousTargetCrashCount > crashCountAtStart) {
                throw new Error(`Target crashed while opening ${post.url}.`);
            }

            return record;
        } catch (error) {
            lastError = error;

            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw error;
            }

            if (
                attempt < DETAIL_PAGE_MAX_ATTEMPTS &&
                isRetryablePageError(error)
            ) {
                await sleep(attempt * 1_500);
                continue;
            }

            break;
        } finally {
            await closePageSafely(
                detailPage,
                `detail page for ${post.url}`,
            );
        }
    }

    throw lastError || new Error(`Could not open ${post.url}.`);
}

async function processStandardSearchTerm({
    context,
    query,
    runId,
    seenDuringRun,
}) {
    const expectedLeadTypes = STANDARD_SEARCH_TERM_LEAD_TYPES[query] || [];
    const sourceKind = getSourceKind(query);
    const distanceMiles = getSearchDistance(query);

    await startTermAudit({
        runId,
        searchTerm: query,
        sourceKind,
        expectedLeadTypes,
        distanceMiles,
        dateFilter: "TODAY",
    });

    const stats = {
        observations: 0,
        uniquePosts: 0,
        existingSkipped: 0,
        crossTermSkipped: 0,
        newCandidates: 0,
        inserted: 0,
        failed: 0,
    };

    try {
        const allPosts = await collectPostsForSearchTerm(context, query);
        stats.observations = allPosts.length;
        stats.uniquePosts = allPosts.length;

        const existingAll = await getExistingUrls(allPosts);
        const crossTermUrls = new Set();
        const uniqueForThisRun = [];

        for (const post of allPosts) {
            const url = normalizeRecordUrl(post.url);

            if (seenDuringRun.has(url)) {
                crossTermUrls.add(url);
                continue;
            }

            seenDuringRun.add(url);
            uniqueForThisRun.push(post);
        }

        await logSearchObservations({
            runId,
            searchTerm: query,
            sourceKind,
            expectedLeadTypes,
            items: allPosts,
            existingUrls: existingAll,
            crossTermUrls,
        });

        stats.crossTermSkipped = crossTermUrls.size;

        const fresh = uniqueForThisRun.filter(
            (post) => !existingAll.has(normalizeRecordUrl(post.url)),
        );

        stats.existingSkipped = uniqueForThisRun.length - fresh.length;
        stats.newCandidates = fresh.length;

        console.log(
            `🔁 Cross-term duplicates: ${stats.crossTermSkipped}; ` +
            `existing: ${stats.existingSkipped}; new: ${fresh.length}`,
        );

        for (let index = 0; index < fresh.length; index += 1) {
            const post = fresh[index];

            console.log(
                `[${index + 1}/${fresh.length}] "${query}" → ${post.url}`,
            );

            try {
                const record = await extractPostDetailsWithFreshPage(
                    context,
                    post,
                    query,
                );

                if (!record.description || record.description.length < 10) {
                    throw new Error("No usable description");
                }

                const leadId = await insertUnfilteredRecord(record);
                await markAuditInserted(runId, query, post.url, leadId);
                stats.inserted += 1;
            } catch (error) {
                console.error(
                    `⏭️ Skipping post: ${getErrorMessage(error)}`,
                );
                await markAuditError(
                    runId,
                    query,
                    post.url,
                    getErrorMessage(error),
                ).catch(() => {});
                stats.failed += 1;
            }

            await sleep(700 + Math.floor(Math.random() * 600));
        }

        return stats;
    } finally {
        await finishTermAudit(runId, query, stats).catch((error) => {
            console.warn(
                `⚠️ Could not finalize term audit for "${query}": ` +
                getErrorMessage(error),
            );
        });
    }
}

// ---------------------------------------------------------------------------
// Realtor / FSBO special marketplace flow
// ---------------------------------------------------------------------------

async function clickForSaleAndFree(page) {
    console.log("🛍️ Clicking For Sale & Free...");

    const target = await firstVisible([
        page.getByText("For Sale & Free", { exact: true }),
        page.locator('span[data-block="33"]', { hasText: "For Sale & Free" }),
        page.getByRole("link", { name: /For Sale & Free/i }),
        page.getByRole("button", { name: /For Sale & Free/i }),
        page.locator('text="For Sale & Free"'),
    ]);

    if (!target) {
        throw new Error('Could not find the "For Sale & Free" control.');
    }

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 10_000 });
    await sleep(1_500);
}

async function fillByOwnerSearch(page) {
    console.log(`🔎 Entering marketplace search: ${REALTOR_SEARCH_TEXT}`);

    const search = await firstVisible([
        page.getByRole("searchbox"),
        page.locator('input[type="search"]'),
        page.locator('input[placeholder*="search" i]'),
        page.locator('input[aria-label*="search" i]'),
    ]);

    if (!search) {
        throw new Error("Could not find the marketplace search input.");
    }

    await search.click({ timeout: 10_000 });
    await search.fill(REALTOR_SEARCH_TEXT);
    await sleep(500);
    await search.press("Enter");
    await sleep(1_800);
}

async function chooseHomeSales(page) {
    console.log(`🏠 Selecting category: ${REALTOR_CATEGORY_TEXT}`);

    const categories = await firstVisible([
        page.getByRole("button", { name: /Categories/i }),
        page.locator("button", { hasText: "Categories" }),
        page.getByText(/Categories:/i),
        page.getByText("Categories", { exact: true }),
    ]);

    if (!categories) {
        throw new Error('Could not find the "Categories" control.');
    }

    await categories.scrollIntoViewIfNeeded().catch(() => {});
    await categories.click({ timeout: 10_000 });
    await sleep(700);

    const homeSales = await firstVisible([
        page.getByRole("menuitem", {
            name: new RegExp(`^${REALTOR_CATEGORY_TEXT}$`, "i"),
        }),
        page.getByRole("option", {
            name: new RegExp(`^${REALTOR_CATEGORY_TEXT}$`, "i"),
        }),
        page.getByText(REALTOR_CATEGORY_TEXT, { exact: true }),
        page.locator("label", { hasText: REALTOR_CATEGORY_TEXT }),
        page.locator('[role="menu"] *', { hasText: REALTOR_CATEGORY_TEXT }),
    ]);

    if (!homeSales) {
        throw new Error(
            `Categories opened, but "${REALTOR_CATEGORY_TEXT}" was not found.`,
        );
    }

    await homeSales.click({ timeout: 10_000 });
    await sleep(1_800);
}

async function setupRealtorMarketplace(page) {
    console.log("");
    console.log("============================================================");
    console.log("🏠 REALTOR FLOW: For Sale & Free → by owner → Home sales");
    console.log("============================================================");

    await page.goto("https://nextdoor.com/news_feed/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
    });
    await sleep(2_500);

    await clickForSaleAndFree(page);
    await fillByOwnerSearch(page);
    await chooseHomeSales(page);

    console.log(`✅ Realtor marketplace setup complete: ${page.url()}`);
}

async function collectMarketplaceListings(page, limit = REALTOR_MAX_LISTINGS) {
    console.log("⬇️ Loading realtor marketplace listings...");

    let previousCount = -1;
    let stablePasses = 0;

    for (let pass = 1; pass <= 20; pass += 1) {
        const count = await page.locator("a[href]").count();
        console.log(`   pass ${pass}: ${count} links loaded`);

        stablePasses = count === previousCount ? stablePasses + 1 : 0;
        previousCount = count;

        if (stablePasses >= 4) break;

        await page.mouse.wheel(0, 1_800);
        await sleep(900);
    }

    const listings = await page.evaluate((maxResults) => {
        const clean = (value) =>
            (value || "").replace(/\s+/g, " ").trim();
        const linesOf = (value) =>
            (value || "")
                .split("\n")
                .map((value) => clean(value))
                .filter(Boolean);

        const anchors = [...document.querySelectorAll("a[href]")];
        const results = [];
        const seen = new Set();

        for (const anchor of anchors) {
            const href = anchor.href;
            if (!href || seen.has(href)) continue;
            if (!/^https?:\/\/([^/]+\.)?nextdoor\.com\//i.test(href)) continue;

            const card =
                anchor.closest("article") ||
                anchor.closest('[role="listitem"]') ||
                anchor.closest("li") ||
                anchor;

            const text = clean(card.innerText || anchor.innerText || "");
            const hasImage = Boolean(
                card.querySelector("img") || anchor.querySelector("img"),
            );

            if (!hasImage && text.length < 15) continue;
            if (text.length > 1_200) continue;

            const lowerHref = href.toLowerCase();
            const lowerText = text.toLowerCase();

            if (
                lowerHref.includes("/settings") ||
                lowerHref.includes("/profile") ||
                lowerHref.includes("/notifications") ||
                lowerHref.includes("/news_feed") ||
                lowerHref.includes("/groups") ||
                lowerText === "all listings" ||
                lowerText === "my listings" ||
                lowerText === "saved listings" ||
                lowerText === "saved searches"
            ) {
                continue;
            }

            const lines = linesOf(card.innerText || anchor.innerText || "");
            const price =
                lines.find((line) => /^\$[\d,.]+(?:\s|$)/.test(line)) || null;
            const location =
                lines.find(
                    (line) =>
                        /\b[A-Z]{2}\b/.test(line) ||
                        /\b\d+\s*(mi|miles)\b/i.test(line),
                ) || null;

            const title =
                lines.find((line) => {
                    const lower = line.toLowerCase();
                    return (
                        line !== price &&
                        line !== location &&
                        !/^ad$/i.test(line) &&
                        !/^save$/i.test(line) &&
                        !/^share$/i.test(line) &&
                        !lower.includes("categories:") &&
                        !lower.includes("distance:") &&
                        !lower.includes("sort by:") &&
                        line.length >= 4
                    );
                }) || null;

            const listingSignal =
                price ||
                /home|house|condo|townhome|townhouse|property|bed|bath|sq\.?\s*ft|acre|fsbo|owner/i.test(
                    text,
                ) ||
                /sale|listing|marketplace|for_sale/i.test(lowerHref);

            if (!listingSignal) continue;

            seen.add(href);
            results.push({
                url: href,
                title,
                price,
                location,
                text: text.slice(0, 1_500),
                preview: text.slice(0, 1_500),
            });

            if (results.length >= maxResults) break;
        }

        return results;
    }, limit);

    const unique = new Map();

    for (const listing of listings) {
        const url = normalizeRecordUrl(listing.url);
        if (!unique.has(url)) unique.set(url, { ...listing, url });
    }

    const result = [...unique.values()];
    console.log(`🏠 Found ${result.length} realtor listing candidate(s).`);
    return result;
}

async function extractMarketplaceListingDetails(context, listing) {
    let lastError = null;

    for (let attempt = 1; attempt <= DETAIL_PAGE_MAX_ATTEMPTS; attempt += 1) {
        let page = null;

        try {
            page = await createConfiguredPage(
                context,
                `realtor-detail:attempt:${attempt}`,
            );

            await page.goto(listing.url, {
                waitUntil: "domcontentloaded",
                timeout: 45_000,
            });

            await sleep(1_500);
            await expandSeeMore(page);

            const author = await extractAuthor(page);

            const extracted = await page.evaluate(({ fallbackText }) => {
                const clean = (value) =>
                    (value || "").replace(/\s+/g, " ").trim();

                const candidates = [];
                const selectors = [
                    '[data-testid="styled-text-wrapper"]',
                    '[data-testid="styled-text"]',
                    '[data-testid*="description" i]',
                    '[class*="description" i]',
                    'main [dir="auto"]',
                    "main p",
                ];

                for (const selector of selectors) {
                    for (const element of document.querySelectorAll(selector)) {
                        const text = clean(
                            element.innerText || element.textContent,
                        );

                        if (text.length >= 20 && text.length <= 8_000) {
                            candidates.push(text);
                        }
                    }
                }

                candidates.sort((a, b) => b.length - a.length);

                const lines = document.body.innerText
                    .split("\n")
                    .map(clean)
                    .filter(Boolean);

                const explicitLocation = lines.find((line) =>
                    /^[A-Za-z .'-]+,\s*[A-Z]{2}(?:\b|\s|$)/.test(line),
                );

                return {
                    description: candidates[0] || clean(fallbackText) || null,
                    location: explicitLocation || null,
                };
            }, { fallbackText: listing.text });

            const pieces = [
                listing.title,
                listing.price,
                extracted.description || listing.text,
            ]
                .map(cleanText)
                .filter(Boolean);

            const description = [...new Set(pieces)].join(" — ");
            const location = cleanText(
                listing.location || extracted.location || "",
            );

            const cityState = await resolveCityState({
                location,
                description,
            });

            return {
                author,
                location: location || null,
                description,
                post_url: listing.url,
                city: cityState.city,
                state: cityState.state,
                lead_type: ["realtor"],
                search_term: REALTOR_SEARCH_TERM,
            };
        } catch (error) {
            lastError = error;

            if (
                browserDisconnected ||
                isBrowserDisconnectedError(error)
            ) {
                throw error;
            }

            if (
                attempt < DETAIL_PAGE_MAX_ATTEMPTS &&
                isRetryablePageError(error)
            ) {
                await sleep(attempt * 1_500);
                continue;
            }

            break;
        } finally {
            await closePageSafely(page, `realtor detail page ${listing.url}`);
        }
    }

    throw lastError || new Error(`Could not open realtor listing ${listing.url}.`);
}

async function processRealtor({ context, runId, seenDuringRun }) {
    const expectedLeadTypes = ["realtor"];
    const sourceKind = "realtor_marketplace";

    await startTermAudit({
        runId,
        searchTerm: REALTOR_SEARCH_TERM,
        sourceKind,
        expectedLeadTypes,
        distanceMiles: null,
        dateFilter: null,
    });

    const stats = {
        observations: 0,
        uniquePosts: 0,
        existingSkipped: 0,
        crossTermSkipped: 0,
        newCandidates: 0,
        inserted: 0,
        failed: 0,
    };

    let page = null;

    try {
        page = await createConfiguredPage(context, "realtor-marketplace");
        await setupRealtorMarketplace(page);

        const allListings = await collectMarketplaceListings(
            page,
            REALTOR_MAX_LISTINGS,
        );

        stats.observations = allListings.length;
        stats.uniquePosts = allListings.length;

        const existingAll = await getExistingUrls(allListings);
        const crossTermUrls = new Set();
        const uniqueForThisRun = [];

        for (const listing of allListings) {
            const url = normalizeRecordUrl(listing.url);

            if (seenDuringRun.has(url)) {
                crossTermUrls.add(url);
                continue;
            }

            seenDuringRun.add(url);
            uniqueForThisRun.push(listing);
        }

        await logSearchObservations({
            runId,
            searchTerm: REALTOR_SEARCH_TERM,
            sourceKind,
            expectedLeadTypes,
            items: allListings,
            existingUrls: existingAll,
            crossTermUrls,
        });

        stats.crossTermSkipped = crossTermUrls.size;

        const fresh = uniqueForThisRun.filter(
            (listing) => !existingAll.has(normalizeRecordUrl(listing.url)),
        );

        stats.existingSkipped = uniqueForThisRun.length - fresh.length;
        stats.newCandidates = fresh.length;

        console.log(
            `🏠 Realtor candidates: ${allListings.length}; ` +
            `existing: ${stats.existingSkipped}; new: ${fresh.length}`,
        );

        // Close the marketplace results page before opening individual detail
        // pages so Railway/Chromium stays within its renderer/thread budget.
        await closePageSafely(page, "realtor marketplace results");
        page = null;

        for (let index = 0; index < fresh.length; index += 1) {
            const listing = fresh[index];

            console.log(
                `[${index + 1}/${fresh.length}] REALTOR → ${listing.url}`,
            );

            try {
                const record = await extractMarketplaceListingDetails(
                    context,
                    listing,
                );

                if (!record.description || record.description.length < 10) {
                    throw new Error("No usable realtor listing description");
                }

                const leadId = await insertUnfilteredRecord(record);
                await markAuditInserted(
                    runId,
                    REALTOR_SEARCH_TERM,
                    listing.url,
                    leadId,
                );
                stats.inserted += 1;
            } catch (error) {
                console.error(
                    `⏭️ Skipping realtor listing: ${getErrorMessage(error)}`,
                );

                await markAuditError(
                    runId,
                    REALTOR_SEARCH_TERM,
                    listing.url,
                    getErrorMessage(error),
                ).catch(() => {});

                stats.failed += 1;
            }

            await sleep(800 + Math.floor(Math.random() * 700));
        }

        return stats;
    } finally {
        await closePageSafely(page, "realtor marketplace results");

        await finishTermAudit(
            runId,
            REALTOR_SEARCH_TERM,
            stats,
        ).catch((error) => {
            console.warn(
                `⚠️ Could not finalize realtor term audit: ${getErrorMessage(error)}`,
            );
        });
    }
}

async function triggerFtnEnrichment(totals) {
    if (!CRM_API_BASE_URL) {
        throw new Error("CRM_API_BASE_URL is missing.");
    }

    if (totals.inserted <= 0 && !envEnabled(process.env.FTN_TRIGGER_WHEN_ZERO, false)) {
        console.log("ℹ️ No new rows inserted; skipping FTN trigger.");
        return;
    }

    const endpointUrl =
        process.env.FTN_TRIGGER_URL ||
        new URL(ENRICHMENT_ENDPOINT_PATH, CRM_API_BASE_URL).toString();

    const payload = {
        source_table: TABLE_NAME,
        lead_type: ["realtor", "outdoor_lighting", "bookkeeper"],
        scrape_summary: {
            inserted: totals.inserted,
            failed: totals.failed,
            existing_db_posts_skipped: totals.existingSkipped,
            cross_term_duplicates_skipped: totals.crossTermSkipped,
        },
    };

    const maxAttempts = Math.max(
        1,
        Number(process.env.FTN_TRIGGER_MAX_ATTEMPTS || 3),
    );

    const timeoutMs = Math.max(
        5_000,
        Number(process.env.FTN_TRIGGER_TIMEOUT_MS || 60_000),
    );

    let lastError = null;

    console.log(`🚀 Sending FTN enrichment request → ${endpointUrl}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const response = await fetch(endpointUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(timeoutMs),
            });

            const text = await response.text();
            console.log(`📡 FTN response ${response.status}: ${text || "(empty)"}`);

            if (!response.ok) {
                throw new Error(`FTN trigger returned HTTP ${response.status}`);
            }

            console.log("✅ FTN enrichment request accepted.");
            return;
        } catch (error) {
            lastError = error;
            console.warn(
                `⚠️ FTN trigger attempt ${attempt}/${maxAttempts} failed: ` +
                getErrorMessage(error),
            );

            if (attempt < maxAttempts) {
                await sleep(attempt * 2_000);
            }
        }
    }

    throw lastError || new Error("FTN enrichment trigger failed.");
}

function addStats(totals, stats) {
    totals.inserted += stats.inserted || 0;
    totals.failed += stats.failed || 0;
    totals.existingSkipped += stats.existingSkipped || 0;
    totals.crossTermSkipped += stats.crossTermSkipped || 0;
    totals.newCandidates += stats.newCandidates || 0;
    totals.resultObservations += stats.observations || 0;
}

process.on("uncaughtException", (error) => {
    if (isTargetCrashError(error)) {
        asynchronousTargetCrashCount += 1;
        console.error(
            "🧯 Captured asynchronous Playwright Target crashed error; continuing.",
        );
        return;
    }

    console.error("❌ Uncaught exception:", error?.stack || error);
    process.exit(1);
});

async function main() {
    console.log("🚦 Realtor + Outdoor Lighting + Bookkeeping Scraper Started");

    if (!process.env.MULTILOGIN_WS) {
        throw new Error("MULTILOGIN_WS is missing.");
    }

    await ensureAuditTables();
    await purgeExpiredSearchHistory();

    const standardPlan = buildStandardSearchPlan();
    const plannedSearchTerms = standardPlan.length + (RUN_REALTOR ? 1 : 0);
    const runId = randomUUID();

    const totals = {
        inserted: 0,
        failed: 0,
        existingSkipped: 0,
        crossTermSkipped: 0,
        newCandidates: 0,
        resultObservations: 0,
        uniqueResultUrls: 0,
    };

    let browser = null;
    let bootstrapPage = null;
    let searchRunFinalized = false;

    await createSearchRun(runId, plannedSearchTerms);
    console.log(`🆔 Special search run: ${runId}`);
    console.log(`📌 Planned workflows/terms: ${plannedSearchTerms}`);

    try {
        browser = await chromium.connectOverCDP(process.env.MULTILOGIN_WS);

        browser.on("disconnected", () => {
            browserDisconnected = true;
            console.error(
                "💥 Playwright disconnected from the Multilogin browser.",
            );
        });

        const context = browser.contexts()[0];

        if (!context) {
            throw new Error("No Multilogin browser context found.");
        }

        bootstrapPage = await waitForNextdoorReady(context, 180_000);
        await closeStaleContextPages(context, bootstrapPage);

        const seenDuringRun = new Set();

        // Realtor is intentionally separate because it is NOT a normal Posts
        // search. It reproduces the locally-proven marketplace click/search/
        // category sequence.
        if (RUN_REALTOR) {
            const realtorStats = await processRealtor({
                context,
                runId,
                seenDuringRun,
            });
            addStats(totals, realtorStats);
        }

        for (let index = 0; index < standardPlan.length; index += 1) {
            const query = standardPlan[index];

            if (browserDisconnected || !browser.isConnected()) {
                throw new Error(
                    `BROWSER_DISCONNECTED before search term "${query}".`,
                );
            }

            console.log("");
            console.log("############################################################");
            console.log(
                `🔎 STANDARD SEARCH ${index + 1}/${standardPlan.length}: ` +
                `"${query}" → ${getSearchDistance(query)} miles + Today`,
            );
            console.log("############################################################");

            try {
                const stats = await processStandardSearchTerm({
                    context,
                    query,
                    runId,
                    seenDuringRun,
                });

                addStats(totals, stats);
            } catch (error) {
                if (
                    browserDisconnected ||
                    isBrowserDisconnectedError(error)
                ) {
                    throw error;
                }

                console.error(
                    `⏭️ Skipping search term "${query}": ${getErrorMessage(error)}`,
                );
                totals.failed += 1;
            }
        }

        totals.uniqueResultUrls = seenDuringRun.size;

        console.log("");
        console.log("============================================================");
        console.log("✅ Special scrape finished.");
        console.log(`   Run ID: ${runId}`);
        console.log(`   Observations: ${totals.resultObservations}`);
        console.log(`   Unique URLs: ${totals.uniqueResultUrls}`);
        console.log(`   New candidates: ${totals.newCandidates}`);
        console.log(`   Inserted: ${totals.inserted}`);
        console.log(`   Failed: ${totals.failed}`);
        console.log(`   Existing DB posts: ${totals.existingSkipped}`);
        console.log(`   Cross-term duplicates: ${totals.crossTermSkipped}`);
        console.log(
            `   Async target crashes recovered: ${asynchronousTargetCrashCount}`,
        );
        console.log("============================================================");

        await finishSearchRun(runId, "completed", totals);
        searchRunFinalized = true;

        await triggerFtnEnrichment(totals);
    } catch (error) {
        if (!searchRunFinalized) {
            await finishSearchRun(
                runId,
                "failed",
                totals,
                getErrorMessage(error),
            ).catch(() => {});
        }

        throw error;
    } finally {
        await closePageSafely(bootstrapPage, "bootstrap page");
        await pool.end().catch(() => {});

        // IMPORTANT: do not browser.close() here. This scraper connects to a
        // remote Multilogin profile over CDP and may share that profile with
        // another Railway job. Let process exit close only this CDP client.
        console.log("✅ Scraper resources closed; remote Multilogin browser left running.");
    }
}

main()
    .then(async () => {
        await sleep(250);
        process.exit(0);
    })
    .catch(async (error) => {
        console.error(
            "❌ Fatal scraper error:",
            error?.stack || error?.message || error,
        );
        await pool.end().catch(() => {});
        process.exit(1);
    });
