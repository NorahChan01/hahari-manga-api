const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangapark.cc";

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/139.0.0.0 Safari/537.36",

    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,image/apng,*/*;q=0.8",

    "Accept-Language": "en-US,en;q=0.9",

    "Referer": BASE_URL + "/",

    "Cache-Control": "no-cache",

    "Pragma": "no-cache"
};

function cleanText(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTitle(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function slugify(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function absoluteUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/gi, "&")
        .replace(/\\\//g, "/")
        .trim();

    if (url.startsWith("//")) {
        return "https:" + url;
    }

    if (url.startsWith("/")) {
        return BASE_URL + url;
    }

    if (/^https?:\/\//i.test(url)) {
        return url;
    }

    return null;
}

function extractLinks(html) {
    const results = [];

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const href = absoluteUrl(match[1]);
        const text = cleanText(match[2]);

        if (!href) continue;

        results.push({
            href,
            text
        });
    }

    return results;
}

function extractImageUrls(html) {
    const results = [];
    const seen = new Set();

    function add(url) {
        if (!url) return;

        url = absoluteUrl(url);

        if (!url) return;

        if (
            /favicon|logo|avatar|icon|sprite|banner|advert|ads\./i.test(
                url
            )
        ) {
            return;
        }

        /*
         * MangaPark currently uses image hosts such as
         * c.imgeu2.lol.
         *
         * Accept normal image extensions.
         */
        if (
            !/\.(?:jpg|jpeg|png|webp|gif)(?:[?#]|$)/i.test(
                url
            )
        ) {
            return;
        }

        if (seen.has(url)) return;

        seen.add(url);
        results.push(url);
    }

    let match;

    /*
     * img src
     */
    const srcRegex =
        /<(?:img|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcRegex.exec(html))) {
        add(match[1]);
    }

    /*
     * Lazy-loaded images.
     */
    const lazyRegex =
        /<(?:img|source)\b[^>]*?\b(?:data-src|data-original|data-lazy-src|data-image|data-url)\s*=\s*["']([^"']+)["']/gi;

    while ((match = lazyRegex.exec(html))) {
        add(match[1]);
    }

    /*
     * srcset.
     */
    const srcsetRegex =
        /\bsrcset\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcsetRegex.exec(html))) {
        const parts = match[1]
            .split(",")
            .map(x => x.trim());

        for (const part of parts) {
            const url = part.split(/\s+/)[0];
            add(url);
        }
    }

    /*
     * Images inside anchor hrefs.
     */
    const hrefImageRegex =
        /<a\b[^>]*href\s*=\s*["']([^"']+\.(?:jpg|jpeg|png|webp|gif)(?:[?#][^"']*)?)["']/gi;

    while ((match = hrefImageRegex.exec(html))) {
        add(match[1]);
    }

    /*
     * Direct URLs embedded in HTML/JSON.
     */
    const directRegex =
        /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = directRegex.exec(html))) {
        add(
            match[0]
                .replace(/\\\//g, "/")
                .replace(/\\"/g, '"')
        );
    }

    return results;
}

async function request(url, extraHeaders = {}) {
    try {
        const response = await axios.get(url, {
            headers: {
                ...HEADERS,
                ...extraHeaders
            },

            httpsAgent,

            timeout: 30000,

            maxRedirects: 10,

            validateStatus: status =>
                status >= 200 && status < 400
        });

        return response.data;
    } catch (error) {
        if (error.response) {
            throw new Error(
                `HTTP ${error.response.status}`
            );
        }

        if (error.code === "ECONNABORTED") {
            throw new Error(
                "MangaPark request timed out."
            );
        }

        throw new Error(
            error.message ||
            "MangaPark request failed."
        );
    }
}

/*
 * Find a MangaPark manga page.
 *
 * Current structure:
 *   /manga/girl-and-science
 */
async function searchManga(title) {
    const wanted = normalizeTitle(title);

    if (!wanted) {
        return null;
    }

    /*
     * First try the predictable MangaPark slug.
     *
     * This is important because MangaPark's current
     * public manga pages use /manga/<slug>.
     */
    const guessedSlug = slugify(title);

    const directUrl =
        `${BASE_URL}/manga/${guessedSlug}`;

    try {
        const html =
            await request(directUrl);

        /*
         * Make sure this is actually a manga page.
         */
        if (
            /<h1[^>]*>[\s\S]*?Girl and Science/i.test(
                html
            ) ||
            /class=["'][^"']*manga[^"']*["']/i.test(
                html
            ) ||
            /\/read\/[^"' ]+\/en\/chapter-/i.test(
                html
            )
        ) {
            return {
                title,
                url: directUrl,
                slug: guessedSlug
            };
        }
    } catch {
        /*
         * Continue to search fallback.
         */
    }

    /*
     * MangaPark search fallback.
     */
    const searchUrls = [
        `${BASE_URL}/search?keyword=${encodeURIComponent(title)}`,
        `${BASE_URL}/search?q=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/${encodeURIComponent(title)}`
    ];

    for (const searchUrl of searchUrls) {
        let html;

        try {
            html =
                await request(searchUrl);
        } catch {
            continue;
        }

        const links =
            extractLinks(html);

        const mangaLinks =
            links.filter(item =>
                /\/manga\/[^/?#]+/i.test(
                    item.href
                )
            );

        let best = null;
        let bestScore = 0;

        for (const item of mangaLinks) {
            const textTitle =
                normalizeTitle(item.text);

            let urlTitle = "";

            try {
                const pathname =
                    new URL(item.href).pathname;

                const parts =
                    pathname
                        .split("/")
                        .filter(Boolean);

                urlTitle =
                    normalizeTitle(
                        parts[parts.length - 1] || ""
                    );
            } catch {}

            let score = 0;

            if (textTitle === wanted) {
                score += 200;
            }

            if (urlTitle === wanted) {
                score += 180;
            }

            if (
                textTitle.includes(wanted) ||
                wanted.includes(textTitle)
            ) {
                score += 100;
            }

            if (
                urlTitle.includes(wanted) ||
                wanted.includes(urlTitle)
            ) {
                score += 90;
            }

            if (score > bestScore) {
                bestScore = score;

                best = {
                    title:
                        item.text ||
                        title,

                    url:
                        item.href
                };
            }
        }

        if (best && bestScore >= 40) {
            return best;
        }
    }

    return null;
}

/*
 * Find chapter directly from MangaPark's current
 * reader URL structure:
 *
 * /read/<slug>/en/chapter-20
 */
async function getChapter(title, chapter) {
    const wantedTitle =
        String(title || "").trim();

    const wantedChapter =
        String(chapter || "").trim();

    if (!wantedTitle) {
        throw new Error(
            "Manga title is required."
        );
    }

    if (!wantedChapter) {
        throw new Error(
            "Chapter number is required."
        );
    }

    /*
     * Find manga.
     */
    const manga =
        await searchManga(wantedTitle);

    if (!manga) {
        throw new Error(
            `Manga "${wantedTitle}" not found on MangaPark.`
        );
    }

    /*
     * Extract slug from the manga URL.
     */
    let slug = manga.slug;

    if (!slug) {
        try {
            const pathname =
                new URL(manga.url).pathname;

            const parts =
                pathname
                    .split("/")
                    .filter(Boolean);

            const mangaIndex =
                parts.indexOf("manga");

            if (
                mangaIndex !== -1 &&
                parts[mangaIndex + 1]
            ) {
                slug =
                    parts[mangaIndex + 1];
            }
        } catch {}
    }

    if (!slug) {
        slug = slugify(wantedTitle);
    }

    /*
     * Current MangaPark English reader.
     */
    const chapterUrl =
        `${BASE_URL}/read/${slug}/en/chapter-${encodeURIComponent(wantedChapter)}`;

    let chapterHtml;

    try {
        chapterHtml =
            await request(
                chapterUrl,
                {
                    "Referer":
                        manga.url ||
                        `${BASE_URL}/manga/${slug}`
                }
            );
    } catch (error) {
        /*
         * Some chapters may have decimal numbers
         * or special formatting. Try finding the
         * chapter URL from the manga page.
         */
        let mangaHtml;

        try {
            mangaHtml =
                await request(
                    manga.url ||
                    `${BASE_URL}/manga/${slug}`
                );
        } catch {
            throw error;
        }

        const links =
            extractLinks(mangaHtml);

        const wantedNumber =
            Number(wantedChapter);

        const chapterLinks =
            links.filter(item => {
                if (
                    !/\/read\//i.test(
                        item.href
                    )
                ) {
                    return false;
                }

                const combined =
                    `${item.href} ${item.text}`;

                const match =
                    combined.match(
                        /chapter[-_ ]*(\d+(?:\.\d+)?)/i
                    );

                if (!match) {
                    return false;
                }

                const number =
                    Number(match[1]);

                return (
                    Number.isFinite(number) &&
                    number === wantedNumber
                );
            });

        if (!chapterLinks.length) {
            throw new Error(
                `Chapter ${wantedChapter} not found on MangaPark.`
            );
        }

        chapterHtml =
            await request(
                chapterLinks[0].href,
                {
                    "Referer":
                        manga.url
                }
            );
    }

    /*
     * Make sure the requested chapter was actually
     * returned.
     */
    const chapterTitleMatch =
        chapterHtml.match(
            /<h1[^>]*>([\s\S]*?)<\/h1>/i
        );

    if (chapterTitleMatch) {
        const chapterTitle =
            cleanText(
                chapterTitleMatch[1]
            );

        const chapterNumber =
            chapterTitle.match(
                /chapter\s*(\d+(?:\.\d+)?)/i
            );

        if (
            chapterNumber &&
            !numberEquals(
                chapterNumber[1],
                wantedChapter
            )
        ) {
            throw new Error(
                `MangaPark returned chapter ${chapterNumber[1]} instead of ${wantedChapter}.`
            );
        }
    }

    /*
     * Extract pages.
     */
    let pages =
        extractImageUrls(
            chapterHtml
        );

    pages = [...new Set(pages)];

    if (!pages.length) {
        throw new Error(
            "MangaPark chapter contained no readable images."
        );
    }

    /*
     * Preserve page order.
     */
    pages = pages.filter(Boolean);

    return {
        title:
            wantedTitle,

        chapter:
            wantedChapter,

        source:
            "MangaPark",

        pages
    };
}

module.exports = {
    name: "MangaPark",

    async getChapter(title, chapter) {
        return await getChapter(
            title,
            chapter
        );
    }
};
