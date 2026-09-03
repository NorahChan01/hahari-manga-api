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

function validImage(url) {
    if (!url) return false;

    const lower = url.toLowerCase();

    if (
        !(
            lower.includes("2xstorage.com") ||
            lower.includes("waitst.com")
        )
    ) {
        return false;
    }

    return /\.(webp|jpg|jpeg|png)(?:\?|$)/i.test(lower);
}

function sortPages(pages) {
    return pages.sort((a, b) => {
        const getNumber = url => {
            const match = url.match(
                /(?:\/|_)(\d+)\.(?:webp|jpg|jpeg|png)/i
            );

            return match
                ? Number(match[1])
                : Number.MAX_SAFE_INTEGER;
        };

        return getNumber(a) - getNumber(b);
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

    let browser;

    try {
        browser = await puppeteer.launch({
            headless: true,

            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-first-run",
                "--no-zygote",
                "--single-process"
            ]
        });

        const page = await browser.newPage();

        await page.setViewport({
            width: 1366,
            height: 900,
            deviceScaleFactor: 1
        });

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36"
        );

        await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9"
        });

        /*
         * Block unnecessary resources.
         * Images are intentionally NOT blocked.
         */
        await page.setRequestInterception(true);

        page.on("request", request => {
            const type = request.resourceType();

            if (
                type === "font" ||
                type === "media" ||
                type === "manifest"
            ) {
                request.abort();
            } else {
                request.continue();
            }
        });

        console.log(
            `[MangaKakalot] Opening ${url}`
        );

        await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        /*
         * Give Cloudflare / JavaScript time to finish.
         */
        await new Promise(resolve =>
            setTimeout(resolve, 5000)
        );

        /*
         * Scroll through the reader.
         * Some reader pages lazy-load images.
         */
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let total = 0;

                const timer = setInterval(() => {
                    window.scrollBy(
                        0,
                        Math.max(
                            window.innerHeight,
                            800
                        )
                    );

                    total += 800;

                    if (
                        total >=
                        document.body.scrollHeight + 5000
                    ) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 150);
            });
        });

        await new Promise(resolve =>
            setTimeout(resolve, 3000)
        );

        /*
         * Extract every image visible to the browser.
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
                    add(img.getAttribute("data-src"));
                    add(img.getAttribute("data-original"));
                    add(img.getAttribute("data-lazy-src"));
                    add(img.getAttribute("data-url"));

                    const srcset =
                        img.getAttribute("srcset");

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

        const pages = sortPages(
            images.filter(validImage)
        );

        /*
         * Detect Cloudflare/access page.
         */
        const pageText = await page.evaluate(() =>
            document.body
                ? document.body.innerText || ""
                : ""
        );

        const blocked =
            /checking your browser|verify you are human|just a moment|cloudflare/i
                .test(pageText);

        if (blocked && pages.length === 0) {
            throw new Error(
                "MangaKakalot Cloudflare challenge blocked the browser."
            );
        }

        if (pages.length === 0) {
            throw new Error(
                `MangaKakalot opened the chapter page but no reader images were found. URL: ${url}`
            );
        }

        console.log(
            `[MangaKakalot] Found ${pages.length} pages`
        );

        return {
            title,
            chapter: chapterNumber,
            source: "MangaKakalot",
            pages
        };

    } catch (error) {
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
