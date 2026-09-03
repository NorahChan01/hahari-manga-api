const puppeteer = require("puppeteer");

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
    const chapterNumber = normalizeChapter(chapter);

    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (!chapterNumber) {
        throw new Error("Chapter number is required.");
    }

    const slug = slugify(title);

    const url =
        `${BASE_URL}/manga/${slug}/chapter-${chapterNumber}`;

    let browser = null;

    try {
        /*
         * IMPORTANT:
         * Let Puppeteer determine the executable.
         *
         * This avoids hard-coding a Chrome version.
         */
        const executablePath =
            puppeteer.executablePath();

        console.log(
            `[MangaKakalot] Puppeteer executable: ${executablePath}`
        );

        if (!executablePath) {
            throw new Error(
                "Puppeteer could not determine the Chrome executable."
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
            "Chrome/139.0.0.0 Safari/537.36"
        );

        await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9"
        });

        /*
         * Don't block images.
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
            `[MangaKakalot] Opening ${url}`
        );

        const response = await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        const status =
            response
                ? response.status()
                : "unknown";

        console.log(
            `[MangaKakalot] HTTP status: ${status}`
        );

        /*
         * Give JavaScript / anti-bot systems time to finish.
         */
        await new Promise(resolve =>
            setTimeout(resolve, 6000)
        );

        /*
         * Scroll the entire reader.
         *
         * This is important because many manga readers
         * lazy-load pages only after scrolling.
         */
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let lastHeight = 0;
                let stableCount = 0;
                let safety = 0;

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

                    safety++;

                    if (
                        stableCount >= 5 ||
                        safety >= 100
                    ) {
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
         * Extract every possible image URL.
         */
        const images = await page.evaluate(() => {
            const found = new Set();

            function add(value) {
                if (!value) return;

                try {
                    const absolute =
                        new URL(
                            value,
                            location.href
                        ).href;

                    found.add(absolute);
                } catch {}
            }

            /*
             * Normal <img> elements.
             */
            document
                .querySelectorAll("img")
                .forEach(img => {
                    add(img.src);
                    add(img.currentSrc);

                    add(
                        img.getAttribute("src")
                    );

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

                    add(
                        img.getAttribute("data-lazy")
                    );

                    /*
                     * srcset
                     */
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
             * <source> elements.
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
                                const value =
                                    item
                                        .trim()
                                        .split(/\s+/)[0];

                                add(value);
                            });
                    }
                });

            /*
             * Some readers store image URLs in
             * lazy-loading attributes.
             */
            document
                .querySelectorAll(
                    "[data-src], [data-original], [data-lazy-src]"
                )
                .forEach(element => {
                    add(
                        element.getAttribute("data-src")
                    );

                    add(
                        element.getAttribute("data-original")
                    );

                    add(
                        element.getAttribute("data-lazy-src")
                    );
                });

            return Array.from(found);
        });

        /*
         * Detect anti-bot pages.
         */
        const pageText =
            await page.evaluate(() =>
                document.body
                    ? document.body.innerText || ""
                    : ""
            );

        const blocked =
            /checking your browser|verify you are human|just a moment|attention required|cloudflare/i
                .test(pageText);

        /*
         * Filter manga pages.
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
            `[MangaKakalot] Valid manga pages: ${pages.length}`
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
         * Final deduplication.
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

        /*
         * Re-sort after deduplication.
         */
        sortPages(uniquePages);

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
