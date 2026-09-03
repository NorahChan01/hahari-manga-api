const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://www.mangakakalot.gg";

const CACHE_DIR =
    process.env.PUPPETEER_CACHE_DIR ||
    "/opt/render/project/src/.puppeteer-cache";

/*
 * Find Chrome recursively inside Puppeteer's cache.
 * This avoids Puppeteer's cached executablePath configuration.
 */
function findChromeExecutable(dir) {
    if (!fs.existsSync(dir)) {
        return null;
    }

    const possible = [];

    function walk(current, depth = 0) {
        if (depth > 6) return;

        let entries;

        try {
            entries = fs.readdirSync(current, {
                withFileTypes: true
            });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath =
                path.join(current, entry.name);

            if (entry.isFile()) {
                if (
                    entry.name === "chrome" ||
                    entry.name === "chrome-wrapper"
                ) {
                    possible.push(fullPath);
                }
            } else if (entry.isDirectory()) {
                walk(fullPath, depth + 1);
            }
        }
    }

    walk(dir);

    for (const file of possible) {
        try {
            if (
                fs.existsSync(file) &&
                fs.statSync(file).isFile()
            ) {
                return file;
            }
        } catch {}
    }

    return null;
}

/*
 * Also check common system Chrome locations.
 */
function findChrome() {
    const locations = [
        path.join(
            CACHE_DIR,
            "chrome"
        ),

        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser"
    ];

    for (const location of locations) {
        try {
            if (
                fs.existsSync(location) &&
                fs.statSync(location).isFile()
            ) {
                return location;
            }
        } catch {}
    }

    /*
     * Puppeteer cache is normally:
     *
     * .puppeteer-cache/
     *   chrome/
     *     linux-XXXXXXXXX/
     *       chrome-linux64/
     *         chrome
     */
    return findChromeExecutable(
        path.join(CACHE_DIR, "chrome")
    );
}

function normalizeChapter(chapter) {
    return String(chapter || "")
        .trim()
        .replace(/^chapter\s*/i, "")
        .replace(/^ch\.?\s*/i, "")
        .trim();
}

function slugify(title) {
    return String(title || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

function isMangaImage(url) {
    if (!url) return false;

    const lower = url.toLowerCase();

    if (
        lower.startsWith("data:") ||
        lower.includes("logo") ||
        lower.includes("icon") ||
        lower.includes("avatar") ||
        lower.includes("banner") ||
        lower.includes("advert") ||
        lower.includes("favicon")
    ) {
        return false;
    }

    return (
        /\.(webp|jpg|jpeg|png)(?:[?#].*)?$/i.test(lower) ||
        lower.includes("2xstorage") ||
        lower.includes("waitst")
    );
}

function sortPages(pages) {
    return pages.sort((a, b) => {
        function getNumber(url) {
            const match = url.match(
                /(?:\/|_|-)(\d+)\.(?:webp|jpg|jpeg|png)(?:[?#].*)?$/i
            );

            return match
                ? Number(match[1])
                : Number.MAX_SAFE_INTEGER;
        }

        return getNumber(a) - getNumber(b);
    });
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error(
            "Manga title is required."
        );
    }

    const chapterNumber =
        normalizeChapter(chapter);

    if (!chapterNumber) {
        throw new Error(
            "Chapter number is required."
        );
    }

    const slug =
        slugify(title);

    const url =
        `${BASE_URL}/manga/${slug}/chapter-${chapterNumber}`;

    let browser = null;

    try {
        console.log(
            `[MangaKakalot] Puppeteer cache: ${CACHE_DIR}`
        );

        /*
         * DO NOT use puppeteer.executablePath().
         *
         * We locate the actual binary ourselves.
         */
        const executablePath =
            findChrome();

        if (!executablePath) {
            throw new Error(
                `Chrome executable not found in ${CACHE_DIR}. ` +
                `Make sure the Render build command installs Chrome into this cache.`
            );
        }

        console.log(
            `[MangaKakalot] Chrome executable: ${executablePath}`
        );

        browser =
            await puppeteer.launch({
                headless: true,
                executablePath,

                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--disable-software-rasterizer",
                    "--no-first-run",
                    "--no-zygote",
                    "--disable-background-networking",
                    "--disable-background-timer-throttling",
                    "--disable-renderer-backgrounding"
                ]
            });

        const page =
            await browser.newPage();

        await page.setViewport({
            width: 1366,
            height: 900,
            deviceScaleFactor: 1
        });

        await page.setUserAgent(
            "Mozilla/5.0 (X11; Linux x86_64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/140.0.0.0 Safari/537.36"
        );

        await page.setExtraHTTPHeaders({
            "Accept-Language":
                "en-US,en;q=0.9"
        });

        /*
         * Don't block images.
         */
        await page.setRequestInterception(
            true
        );

        page.on(
            "request",
            request => {
                const type =
                    request.resourceType();

                if (
                    type === "font" ||
                    type === "media" ||
                    type === "websocket"
                ) {
                    request.abort();
                } else {
                    request.continue();
                }
            }
        );

        console.log(
            `[MangaKakalot] Opening: ${url}`
        );

        const response =
            await page.goto(url, {
                waitUntil:
                    "domcontentloaded",
                timeout: 60000
            });

        console.log(
            `[MangaKakalot] HTTP: ${
                response
                    ? response.status()
                    : "unknown"
            }`
        );

        /*
         * Wait for JavaScript.
         */
        await new Promise(
            resolve =>
                setTimeout(resolve, 5000)
        );

        /*
         * Scroll to trigger lazy loading.
         */
        await page.evaluate(
            async () => {
                await new Promise(
                    resolve => {
                        let lastHeight = 0;
                        let stable = 0;
                        let attempts = 0;

                        const timer =
                            setInterval(() => {
                                window.scrollBy(
                                    0,
                                    Math.max(
                                        window.innerHeight * 0.8,
                                        700
                                    )
                                );

                                const height =
                                    document.body
                                        ? document.body
                                            .scrollHeight
                                        : 0;

                                if (
                                    height ===
                                    lastHeight
                                ) {
                                    stable++;
                                } else {
                                    stable = 0;
                                    lastHeight =
                                        height;
                                }

                                attempts++;

                                if (
                                    stable >= 5 ||
                                    attempts >= 100
                                ) {
                                    clearInterval(
                                        timer
                                    );

                                    resolve();
                                }
                            }, 300);
                    }
                );
            }
        );

        await new Promise(
            resolve =>
                setTimeout(resolve, 3000)
        );

        /*
         * Extract every possible reader image.
         */
        const images =
            await page.evaluate(() => {
                const found =
                    new Set();

                function add(value) {
                    if (!value) return;

                    try {
                        found.add(
                            new URL(
                                value,
                                location.href
                            ).href
                        );
                    } catch {}
                }

                document
                    .querySelectorAll("img")
                    .forEach(img => {
                        add(img.src);
                        add(img.currentSrc);

                        for (
                            const attr of [
                                "src",
                                "data-src",
                                "data-original",
                                "data-lazy-src",
                                "data-url",
                                "data-image",
                                "data-lazy"
                            ]
                        ) {
                            add(
                                img.getAttribute(
                                    attr
                                )
                            );
                        }

                        const srcset =
                            img.getAttribute(
                                "srcset"
                            );

                        if (srcset) {
                            srcset
                                .split(",")
                                .forEach(
                                    item => {
                                        add(
                                            item
                                                .trim()
                                                .split(
                                                    /\s+/
                                                )[0]
                                        );
                                    }
                                );
                        }
                    });

                document
                    .querySelectorAll(
                        "source"
                    )
                    .forEach(source => {
                        add(
                            source.getAttribute(
                                "src"
                            )
                        );

                        add(
                            source.getAttribute(
                                "data-src"
                            )
                        );

                        const srcset =
                            source.getAttribute(
                                "srcset"
                            );

                        if (srcset) {
                            srcset
                                .split(",")
                                .forEach(
                                    item => {
                                        add(
                                            item
                                                .trim()
                                                .split(
                                                    /\s+/
                                                )[0]
                                        );
                                    }
                                );
                        }
                    });

                return Array.from(found);
            });

        /*
         * Cloudflare/access detection.
         */
        const pageText =
            await page.evaluate(() =>
                document.body
                    ? document.body.innerText ||
                      ""
                    : ""
            );

        const blocked =
            /checking your browser|verify you are human|just a moment|attention required|cloudflare/i
                .test(pageText);

        const pages =
            sortPages(
                [
                    ...new Set(
                        images.filter(
                            isMangaImage
                        )
                    )
                ]
            );

        console.log(
            `[MangaKakalot] Images discovered: ${images.length}`
        );

        console.log(
            `[MangaKakalot] Valid pages: ${pages.length}`
        );

        if (
            blocked &&
            pages.length === 0
        ) {
            throw new Error(
                "MangaKakalot Cloudflare/browser verification blocked the request."
            );
        }

        if (
            pages.length === 0
        ) {
            throw new Error(
                `No manga pages found on MangaKakalot for "${title}" chapter ${chapterNumber}.`
            );
        }

        const uniquePages = [];
        const seen = new Set();

        for (
            const image of pages
        ) {
            const clean =
                image.split("#")[0];

            if (
                !seen.has(clean)
            ) {
                seen.add(clean);
                uniquePages.push(
                    image
                );
            }
        }

        sortPages(
            uniquePages
        );

        console.log(
            `[MangaKakalot] Final pages: ${uniquePages.length}`
        );

        return {
            title,
            chapter: chapterNumber,
            source: "MangaKakalot",
            pages: uniquePages
        };

    } catch (error) {
        console.error(
            `[MangaKakalot] ${error.message}`
        );

        throw new Error(
            error.message ||
            "MangaKakalot browser request failed."
        );

    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch {}
        }
    }
}

module.exports = {
    name: "MangaKakalot",
    getChapter
};
