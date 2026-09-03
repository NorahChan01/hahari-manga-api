const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://www.mangakakalot.gg";

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

/*
 * Try Puppeteer's configured browser cache first.
 */
function findChrome() {
    const cacheDir =
        process.env.PUPPETEER_CACHE_DIR ||
        path.join(
            process.env.HOME || "/tmp",
            ".cache",
            "puppeteer"
        );

    const possiblePaths = [
        // Puppeteer Chrome
        path.join(
            cacheDir,
            "chrome",
            "linux-148.0.7778.97",
            "chrome-linux64",
            "chrome"
        ),

        // Other common Puppeteer layouts
        path.join(
            cacheDir,
            "chrome",
            "linux-147.0.7727.63",
            "chrome-linux64",
            "chrome"
        ),

        path.join(
            cacheDir,
            "chrome",
            "linux-146.0.7680.153",
            "chrome-linux64",
            "chrome"
        ),

        // Render/system Chrome locations
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser"
    ];

    for (const executable of possiblePaths) {
        try {
            if (
                fs.existsSync(executable) &&
                fs.statSync(executable).isFile()
            ) {
                console.log(
                    `[MangaKakalot] Chrome found: ${executable}`
                );

                return executable;
            }
        } catch {}
    }

    return null;
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
        lower.includes("advert")
    ) {
        return false;
    }

    /*
     * Accept normal image extensions.
     */
    if (
        /\.(webp|jpg|jpeg|png)(?:[?#].*)?$/i.test(lower)
    ) {
        return true;
    }

    /*
     * Some reader CDNs don't expose the extension cleanly.
     */
    if (
        lower.includes("2xstorage") ||
        lower.includes("waitst") ||
        lower.includes("chapter") ||
        lower.includes("/manga/")
    ) {
        return true;
    }

    return false;
}

function sortPages(pages) {
    return pages.sort((a, b) => {
        function number(url) {
            const match = url.match(
                /(?:\/|_|-)(\d+)\.(?:webp|jpg|jpeg|png)(?:[?#].*)?$/i
            );

            return match
                ? Number(match[1])
                : Number.MAX_SAFE_INTEGER;
        }

        return number(a) - number(b);
    });
}

async function getChapter(title, chapter) {
    const chapterNumber = normalizeChapter(chapter);
    const slug = slugify(title);

    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (!chapterNumber) {
        throw new Error("Chapter number is required.");
    }

    const url =
        `${BASE_URL}/manga/${slug}/chapter-${chapterNumber}`;

    let browser = null;

    try {
        const executablePath = findChrome();

        if (!executablePath) {
            throw new Error(
                "Chrome executable was not found. " +
                "Puppeteer browser installation is missing."
            );
        }

        browser = await puppeteer.launch({
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

        const page = await browser.newPage();

        await page.setViewport({
            width: 1366,
            height: 900,
            deviceScaleFactor: 1
        });

        await page.setUserAgent(
            "Mozilla/5.0 (X11; Linux x86_64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/148.0.0.0 Safari/537.36"
        );

        await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9"
        });

        /*
         * Don't block images.
         * Only block unnecessary heavy resources.
         */
        await page.setRequestInterception(true);

        page.on("request", request => {
            const type = request.resourceType();

            if (
                type === "font" ||
                type === "media" ||
                type === "websocket"
            ) {
                request.abort();
            } else {
                request.continue();
            }
        });

        console.log(
            `[MangaKakalot] Opening: ${url}`
        );

        const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        console.log(
            `[MangaKakalot] HTTP status: ${
                response ? response.status() : "unknown"
            }`
        );

        /*
         * Wait for JavaScript / Cloudflare.
         */
        await new Promise(resolve =>
            setTimeout(resolve, 6000)
        );

        /*
         * Scroll gradually to trigger lazy loading.
         */
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let lastHeight = 0;
                let stableCount = 0;

                const timer = setInterval(() => {
                    window.scrollBy(
                        0,
                        Math.max(
                            window.innerHeight * 0.8,
                            700
                        )
                    );

                    const height =
                        document.body
                            ? document.body.scrollHeight
                            : 0;

                    if (height === lastHeight) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                        lastHeight = height;
                    }

                    if (stableCount >= 5) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 300);
            });
        });

        await new Promise(resolve =>
            setTimeout(resolve, 3000)
        );

        /*
         * Extract images from:
         * img.src
         * img.currentSrc
         * data-src
         * data-original
         * data-lazy-src
         * data-url
         * srcset
         */
        const images = await page.evaluate(() => {
            const found = new Set();

            function add(value) {
                if (!value) return;

                try {
                    const url =
                        new URL(
                            value,
                            location.href
                        ).href;

                    found.add(url);
                } catch {}
            }

            document
                .querySelectorAll("img")
                .forEach(img => {
                    add(img.src);
                    add(img.currentSrc);

                    add(
                        img.getAttribute("data-src")
                    );

                    add(
                        img.getAttribute("data-original")
                    );

                    add(
                        img.getAttribute("data-lazy-src")
                    );

                    add(
                        img.getAttribute("data-url")
                    );

                    add(
                        img.getAttribute("data-image")
                    );

                    const srcset =
                        img.getAttribute("srcset");

                    if (srcset) {
                        srcset
                            .split(",")
                            .forEach(item => {
                                const value =
                                    item
                                        .trim()
                                        .split(/\s+/)[0];

                                add(value);
                            });
                    }
                });

            /*
             * Also inspect picture/source elements.
             */
            document
                .querySelectorAll("source")
                .forEach(source => {
                    add(
                        source.getAttribute("src")
                    );

                    add(
                        source.getAttribute("data-src")
                    );

                    const srcset =
                        source.getAttribute("srcset");

                    if (srcset) {
                        srcset
                            .split(",")
                            .forEach(item => {
                                add(
                                    item
                                        .trim()
                                        .split(/\s+/)[0]
                                );
                            });
                    }
                });

            return Array.from(found);
        });

        /*
         * Get page text for Cloudflare detection.
         */
        const pageText = await page.evaluate(() =>
            document.body
                ? document.body.innerText || ""
                : ""
        );

        const blocked =
            /checking your browser|verify you are human|just a moment|attention required|cloudflare/i
                .test(pageText);

        /*
         * Filter and deduplicate.
         */
        const pages = sortPages(
            [...new Set(
                images.filter(isMangaImage)
            )]
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

        if (pages.length === 0) {
            throw new Error(
                `No manga pages found on MangaKakalot for "${title}" chapter ${chapterNumber}.`
            );
        }

        /*
         * Remove obvious duplicate URLs.
         */
        const uniquePages = [];

        const seen = new Set();

        for (const image of pages) {
            const clean =
                image.split("#")[0];

            if (!seen.has(clean)) {
                seen.add(clean);
                uniquePages.push(image);
            }
        }

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
