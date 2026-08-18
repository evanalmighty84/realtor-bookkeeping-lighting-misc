require('dotenv').config();

const { chromium } = require('playwright-core');
const pool = require('./db/db');
const normalizeCity = require('./normalizeCity');

const SEARCH_QUERY = 'lights';
const TABLE_NAME = 'unfiltered_lights';
const MAX_POSTS = Number(process.env.LIGHTS_MAX_POSTS || 50);
const FALLBACK_STATE = process.env.LIGHTS_FALLBACK_STATE || 'TX';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cleanText(value = '') {
    return String(value).replace(/\s+/g, ' ').trim();
}

function normalizePostUrl(url) {
    try {
        const parsed = new URL(url);
        const postId = parsed.pathname.match(/\/(?:p|posting)\/([^/?#]+)/i)?.[1];
        return postId ? `https://nextdoor.com/p/${postId}` : `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}

function parseExplicitLocation(location = '') {
    const clean = cleanText(location);
    const match = clean.match(/^(.+?),\s*([A-Z]{2})$/);
    return match
        ? { city: match[1].trim(), state: match[2].trim() }
        : { city: clean || null, state: null };
}

function guessCity(location = '') {
    const lower = location.toLowerCase();
    const knownCities = [
        'allen', 'mckinney', 'plano', 'frisco', 'dallas', 'prosper',
        'little elm', 'richardson', 'garland', 'carrollton', 'mesquite',
        'arlington', 'grapevine', 'sachse', 'celina', 'lewisville',
        'desoto', 'north richland hills', 'lowry crossing', 'melissa'
    ];

    const direct = knownCities.find(city => lower.includes(city));
    if (direct) return direct;

    if (lower.includes('craig ranch')) return 'mckinney';
    if (lower.includes('eldorado')) return 'mckinney';
    if (lower.includes('trinity falls')) return 'mckinney';
    if (lower.includes('stonebridge ranch')) return 'mckinney';
    if (lower.includes('westridge')) return 'mckinney';
    if (lower.includes('mckinney north')) return 'mckinney';

    return null;
}

async function resolveCityState({ location, description }) {
    const explicit = parseExplicitLocation(location);
    let city = explicit.city;
    let state = explicit.state || FALLBACK_STATE;

    const guessed = guessCity(location);
    if (guessed) city = guessed;

    try {
        const normalized = await normalizeCity({
            city,
            state,
            location,
            description,
        });

        return {
            city: normalized?.city || city || null,
            state: normalized?.state || state || null,
        };
    } catch (err) {
        console.warn(`⚠️ normalizeCity failed for "${location}": ${err.message}`);
        return { city: city || null, state: state || null };
    }
}

async function getCurrentNextdoorPage(context) {
    const pages = context.pages().filter(page => !page.isClosed());
    return pages.find(page => /nextdoor\.com/i.test(page.url())) || pages[0] || context.newPage();
}

async function findVisibleSearchBox(page) {
    const selectors = [
        'input[aria-label="Search Nextdoor"]',
        'input[placeholder*="Search Nextdoor" i]',
        'input[type="search"]',
        '[data-testid="search-input"] input',
    ];

    for (const selector of selectors) {
        const candidate = page.locator(selector).first();
        if (await candidate.count().catch(() => 0) &&
            await candidate.isVisible().catch(() => false)) {
            return candidate;
        }
    }

    return null;
}

async function waitForNextdoorReady(context, totalMs = 120000) {
    console.log('⏳ Waiting for the Multilogin profile and Nextdoor feed to finish loading...');
    console.log(`   Context has ${context.pages().length} page(s) open`);
    const deadline = Date.now() + totalMs;
    let page = null;
    let navigatedToFeed = false;

    console.log('   Sleeping 7s for Multilogin to stabilize...');
    await sleep(7000);
    console.log('   Initial sleep done, entering wait loop...');

    while (Date.now() < deadline) {
        const remaining = Math.round((deadline - Date.now()) / 1000);
        console.log(`   ⏱ Polling... ${remaining}s remaining`);

        page = await getCurrentNextdoorPage(context);

        if (page && !page.isClosed()) {
            const url = page.url();
            console.log(`   Current page URL: ${url}`);

            if (/nextdoor\.com/i.test(url)) {
                const searchBox = await findVisibleSearchBox(page);
                if (searchBox) {
                    console.log(`✅ Nextdoor is ready: ${url}`);
                    return page;
                }

                if (/\/(login|verify|choose_address)/i.test(url)) {
                    console.log(`ℹ️ Waiting for Nextdoor login/interstitial: ${url}`);
                } else {
                    console.log(`   Nextdoor page is open but still hydrating: ${url}`);
                }
            } else if (!navigatedToFeed) {
                navigatedToFeed = true;
                console.log('🧭 Opening the Nextdoor news feed...');
                await page.goto('https://nextdoor.com/news_feed/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000,
                }).catch(err => console.log(`ℹ️ Initial feed navigation is still settling: ${err.message}`));
            } else {
                console.log(`   Non-Nextdoor page still open: ${url}`);
            }
        } else {
            console.log('   No open page found in context yet...');
        }

        await sleep(2500);
    }

    throw new Error('Nextdoor did not finish loading within 2 minutes. Open the feed in the Multilogin window and run the script again.');
}
async function searchForLights(page) {
    console.log(`🔍 Searching Nextdoor for "${SEARCH_QUERY}"...`);

    if (!/nextdoor\.com/i.test(page.url())) {
        await page.goto('https://nextdoor.com/news_feed/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
    }

    let searchBox = await findVisibleSearchBox(page);

    if (!searchBox) {
        console.log('⏳ Search bar is not visible yet; waiting up to 10 more seconds...');
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline && !searchBox) {
            await sleep(1500);
            searchBox = await findVisibleSearchBox(page);
        }
    }

    if (!searchBox) throw new Error('Could not find the Nextdoor search bar after waiting for the feed.');

    await searchBox.click();
    await searchBox.fill(SEARCH_QUERY);
    await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(3000);

    await goToPostsTab(page);
    await applyMostRecentFilter(page);
    await applyThisWeekFilter(page);
    await sleep(1800);
}

async function goToPostsTab(page) {
    const candidates = [
        page.getByRole('tab', { name: /^Posts$/i }).first(),
        page.locator('[data-testid="tab-posts"]').first(),
        page.locator('a,button').filter({ hasText: /^Posts$/i }).first(),
    ];

    for (const candidate of candidates) {
        try {
            if (await candidate.count() && await candidate.isVisible()) {
                await candidate.click();
                await sleep(1600);
                console.log('✅ Opened Posts results.');
                return;
            }
        } catch {}
    }

    await page.goto(`https://nextdoor.com/search/posts/?query=${encodeURIComponent(SEARCH_QUERY)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });
    await sleep(2000);
    console.log('✅ Opened Posts results directly.');
}

async function applyMostRecentFilter(page) {
    try {
        const trigger = page.locator('[aria-label="Sort By"], div[role="button"][aria-label="Sort By"]').first();
        if (!(await trigger.count()) || !(await trigger.isVisible())) return;
        await trigger.click();
        await sleep(500);
        const option = page.getByText(/^Most Recent$/i).first();
        if (await option.count() && await option.isVisible()) {
            await option.click();
            await sleep(1000);
            console.log('✅ Applied Most Recent.');
        }
    } catch (err) {
        console.log(`ℹ️ Most Recent not applied: ${err.message}`);
    }
}

async function applyThisWeekFilter(page) {
    try {
        const trigger = page.locator('button, [role="button"]').filter({
            hasText: /^(All Time|Today|This Week|This Month|This Year)$/i,
        }).first();
        if (!(await trigger.count()) || !(await trigger.isVisible())) return;
        await trigger.click();
        await sleep(500);
        const option = page.getByText(/^This Week$/i).first();
        if (await option.count() && await option.isVisible()) {
            await option.click();
            await sleep(1000);
            console.log('✅ Applied This Week.');
        }
    } catch (err) {
        console.log(`ℹ️ This Week not applied: ${err.message}`);
    }
}

async function collectPostLinks(page) {
    console.log('⬇️ Loading search results...');
    let previousCount = -1;
    let stablePasses = 0;

    for (let pass = 1; pass <= 20; pass++) {
        const count = await page.locator('a[href*="/p/"], a[href*="/posting/"]').count();
        console.log(`   pass ${pass}: ${count} links loaded`);
        stablePasses = count === previousCount ? stablePasses + 1 : 0;
        previousCount = count;
        if (stablePasses >= 4) break;
        await page.mouse.wheel(0, 1700);
        await sleep(900);
    }

    const raw = await page.evaluate(limit => {
        const results = [];
        const seen = new Set();
        for (const anchor of document.querySelectorAll('a[href*="/p/"], a[href*="/posting/"]')) {
            const href = anchor.href;
            if (!href || seen.has(href)) continue;
            const root = anchor.closest('article, [role="article"], li') || anchor.parentElement;
            const preview = (root?.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim();
            if (preview.length < 15) continue;
            seen.add(href);
            results.push({ url: href, preview: preview.slice(0, 1500) });
            if (results.length >= limit) break;
        }
        return results;
    }, MAX_POSTS);

    const unique = new Map();
    for (const post of raw) unique.set(normalizePostUrl(post.url), { ...post, url: normalizePostUrl(post.url) });
    const posts = [...unique.values()];
    console.log(`🔗 Found ${posts.length} unique posts.`);
    return posts;
}

async function getExistingUrls(posts) {
    const urls = posts.map(post => normalizePostUrl(post.url));
    if (!urls.length) return new Set();

    const { rows } = await pool.query(
        `SELECT post_url FROM ${TABLE_NAME} WHERE post_url = ANY($1::text[])`,
        [urls]
    );
    return new Set(rows.map(row => normalizePostUrl(row.post_url)));
}

async function expandSeeMore(page) {
    const buttons = page.locator('button:has-text("See more"), [data-testid="see-more-text"]');
    const count = Math.min(await buttons.count(), 4);
    for (let i = 0; i < count; i++) {
        try {
            if (await buttons.nth(i).isVisible()) {
                await buttons.nth(i).click({ timeout: 1200 });
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
        const count = Math.min(await links.count(), 15);
        for (let i = 0; i < count; i++) {
            try {
                const link = links.nth(i);
                const text = cleanText(await link.innerText());
                if (/^[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ.'’\-]+){1,5}$/.test(text)) {
                    return text;
                }
                const aria = await link.locator('[aria-label*="Avatar for" i]').first().getAttribute('aria-label').catch(() => null);
                if (aria) return cleanText(aria.replace(/^Avatar for\s*/i, ''));
            } catch {}
        }
    }
    return null;
}

async function extractPostDetails(detailPage, post) {
    const url = normalizePostUrl(post.url);
    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await detailPage.waitForURL(current => normalizePostUrl(current.href) === url, { timeout: 12000 }).catch(() => {});
    await sleep(1400);
    await expandSeeMore(detailPage);

    const author = await extractAuthor(detailPage);
    const extracted = await detailPage.evaluate(({ preview }) => {
        const clean = value => (value || '').replace(/\s+/g, ' ').trim();
        const junk = /Home For Sale & Free Local News Ask Alerts Groups Events Post Settings Help Center/i;
        const tokens = clean(preview).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 4);
        const tokenSet = new Set(tokens.slice(0, 80));

        const candidates = [];
        const selectors = [
            '[data-testid="post-body-text"]',
            '[data-testid="styled-text-wrapper"]',
            'span[data-testid="styled-text"]',
            '.postTextBodySpan',
            'main [dir="auto"]',
        ];

        for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
                const text = clean(element.innerText || element.textContent);
                if (text.length < 20 || text.length > 7000 || junk.test(text)) continue;
                const words = text.toLowerCase().split(/[^a-z0-9]+/);
                const overlap = words.reduce((total, word) => total + (tokenSet.has(word) ? 1 : 0), 0);
                candidates.push({ text, score: overlap * 100 + Math.min(text.length, 1500) });
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        const description = candidates[0]?.text || clean(preview) || null;

        let location = null;
        const neighborhoodLinks = [...document.querySelectorAll('a[href*="/neighborhood/"]')];
        for (const link of neighborhoodLinks) {
            const text = clean(link.innerText);
            if (text && text.length < 100) {
                location = text;
                break;
            }
        }

        if (!location) {
            const lines = document.body.innerText.split('\n').map(clean).filter(Boolean);
            const explicit = lines.find(line => /^[A-Za-z .'-]+,\s*[A-Z]{2}$/.test(line));
            if (explicit) location = explicit;
        }

        return { description, location };
    }, { preview: post.preview });

    const description = cleanText(extracted.description || post.preview);
    const location = cleanText(extracted.location || '');
    const cityState = await resolveCityState({ location, description });

    return {
        author,
        location: location || null,
        description,
        post_url: url,
        city: cityState.city,
        state: cityState.state,
        lead_type: 'lights',
    };
}

async function insertUnfilteredLight(record) {
    const query = `
        INSERT INTO ${TABLE_NAME}
            (author, location, description, post_url, city, state, lead_type, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (post_url) DO UPDATE SET
            author = COALESCE(EXCLUDED.author, ${TABLE_NAME}.author),
            location = COALESCE(EXCLUDED.location, ${TABLE_NAME}.location),
            description = COALESCE(EXCLUDED.description, ${TABLE_NAME}.description),
            city = COALESCE(EXCLUDED.city, ${TABLE_NAME}.city),
            state = COALESCE(EXCLUDED.state, ${TABLE_NAME}.state),
            lead_type = COALESCE(EXCLUDED.lead_type, ${TABLE_NAME}.lead_type)
        RETURNING id
    `;

    await pool.query(query, [
        record.author,
        record.location,
        record.description,
        record.post_url,
        record.city,
        record.state,
        record.lead_type,
    ]);

    console.log(`✅ Saved: ${record.author || '(unknown)'} → ${record.city || '(unknown city)'}, ${record.state || '(unknown state)'}`);
}

async function main() {
    console.log('💡 Nextdoor Unfiltered Lights Scraper Started');

    if (!process.env.MULTILOGIN_WS) throw new Error('MULTILOGIN_WS is missing.');

    const browser = await chromium.connectOverCDP(process.env.MULTILOGIN_WS);
    const context = browser.contexts()[0];
    if (!context) throw new Error('No Multilogin browser context found.');

    const searchPage = await waitForNextdoorReady(context, 120000);
    searchPage.setDefaultTimeout(30000);
    searchPage.setDefaultNavigationTimeout(60000);
    await searchPage.bringToFront();

    await searchForLights(searchPage);
    const allPosts = await collectPostLinks(searchPage);

    const existing = await getExistingUrls(allPosts);
    const posts = allPosts.filter(post => !existing.has(normalizePostUrl(post.url)));
    console.log(`🧱 Duplicate check: ${existing.size} existing, ${posts.length} new.`);

    // Create a worker tab, then immediately return the visible browser to the search results.
    // Playwright can navigate the worker tab in the background without making the results page refresh.
    const detailPage = await context.newPage();
    detailPage.setDefaultTimeout(30000);
    detailPage.setDefaultNavigationTimeout(60000);
    await searchPage.bringToFront();

    let inserted = 0;
    let failed = 0;

    try {
        for (let i = 0; i < posts.length; i++) {
            const post = posts[i];
            console.log(`\n[${i + 1}/${posts.length}] ${post.url}`);
            try {
                const record = await extractPostDetails(detailPage, post);
                console.dir(record, { depth: null });

                if (!record.description || record.description.length < 10) {
                    console.log('⏭️ No usable description.');
                    continue;
                }

                await insertUnfilteredLight(record);
                inserted++;
            } catch (err) {
                console.error(`❌ Failed: ${err.message}`);
                failed++;
            }
            await sleep(650 + Math.floor(Math.random() * 700));
        }
    } finally {
        await detailPage.close().catch(() => {});
        await searchPage.bringToFront().catch(() => {});
        await pool.end().catch(() => {});
    }

    console.log(`\n✅ Finished. Inserted: ${inserted}. Failed: ${failed}. Existing skipped: ${existing.size}.`);
}

main().catch(async err => {
    console.error('❌ Fatal error:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
});
