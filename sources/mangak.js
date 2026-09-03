const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangak.io";

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

    "Accept-Language":
        "en-US,en;q=0.9",

    "Cache-Control":
        "no-cache",

    "Pragma":
        "no-cache"
};

/* -------------------------------------------------- */
/* Helpers                                             */
/* -------------------------------------------------- */

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
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
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

/* -------------------------------------------------- */
/* HTTP                                                */
/* -------------------------------------------------- */

async function request(url, referer = BASE_URL + "/") {
    try {
        const response = await axios.get(url, {
            headers: {
                ...HEADERS,
                Referer: referer
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
                "MangaK request timed out."
            );
        }

        throw new Error(
            error.message ||
            "MangaK request failed."
        );
    }
}

/* -------------------------------------------------- */
/* HTML link extraction                                */
/* -------------------------------------------------- */

function extractLinks(html) {
    const links = [];

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const href = absoluteUrl(match[1]);

        if (!href) {
            continue;
        }

        links.push({
            href,
            text: cleanText(match[2])
        });
    }

    return links;
}

/* -------------------------------------------------- */
/* Image extraction                                    */
/* -------------------------------------------------- */

function extractImages(html) {
    const pages = [];
    const seen = new Set();

    function add(url) {
        if (!url) return;

        url = absoluteUrl(url);

        if (!url) return;

        /*
         * Ignore obvious website assets.
         */
        if (
            /favicon|logo|avatar|icon|sprite|banner|advert|ads\./i.test(
                url
            )
        ) {
            return;
        }

        /*
         * Normal manga image extensions.
         */
        if (
            !/\.(?:jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.test(
                url
            )
        ) {
            return;
        }

        if (seen.has(url)) {
            return;
        }

        seen.add(url);
        pages.push(url);
    }

    let match;

    /*
     * <img src="">
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
        const parts =
            match[1]
                .split(",")
                .map(x => x.trim());

        for (const part of parts) {
            add(
                part.split(/\s+/)[0]
            );
        }
    }

    /*
     * JSON / JavaScript image URLs.
     */
    const directRegex =
        /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|gif|avif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = directRegex.exec(html))) {
        add(
            match[0]
                .replace(/\\\//g, "/")
                .replace(/\\"/g, '"')
        );
    }

    return pages;
}

/* -------------------------------------------------- */
/* Chapter number                                      */
/* -------------------------------------------------- */

function extractChapterNumber(value) {
    const text = String(value || "");

    const patterns = [
        /\bchapter[\s._-]*(\d+(?:\.\d+)?)/i,
        /\bchap[\s._-]*(\d+(?:\.\d+)?)/i,
        /\bch[\s._-]*(\d+(?:\.\d+)?)/i,
        /chapter\/(\d+(?:\.\d+)?)/i,
        /chapter-(\d+(?:\.\d+)?)/i,
        /chapter_(\d+(?:\.\d+)?)/i
    ];

    for (const pattern of patterns) {
        const match =
            text.match(pattern);

        if (match) {
            return match[1];
        }
    }

    return null;
}

function chaptersEqual(a, b) {
    const na = Number(a);
    const nb = Number(b);

    if (
        Number.isFinite(na) &&
        Number.isFinite(nb)
    ) {
        return na === nb;
    }

    return (
        String(a).trim() ===
        String(b).trim()
    );
}

/* -------------------------------------------------- */
/* Search                                              */
/* -------------------------------------------------- */

async function searchManga(title) {
    const query =
        String(title || "").trim();

    if (!query) {
        return null;
    }

    const wanted =
        normalizeTitle(query);

    /*
     * MangaK's current public site has title
     * pages such as:
     *
     * https://mangak.io/jinx
     *
     * Try its search routes first.
     */
    const searchUrls = [
        `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`,
        `${BASE_URL}/search?q=${encodeURIComponent(query)}`,
        `${BASE_URL}/search/${encodeURIComponent(query)}`
    ];

    for (const searchUrl of searchUrls) {
        let html;

        try {
            html =
                await request(searchUrl);
        } catch {
            continue;
        }

        if (
            !html ||
            typeof html !== "string"
        ) {
            continue;
        }

        const links =
            extractLinks(html);

        /*
         * MangaK title pages are generally
         * /<slug>, while /lists, /genres etc.
         * are not manga pages.
         */
        const candidates =
            links.filter(item => {
                try {
                    const pathname =
                        new URL(item.href)
                            .pathname;

                    const parts =
                        pathname
                            .split("/")
                            .filter(Boolean);

                    if (parts.length !== 1) {
                        return false;
                    }

                    const slug =
                        parts[0];

                    return ![
                        "search",
                        "lists",
                        "genres",
                        "genre",
                        "latest",
                        "popular",
                        "trending",
                        "login",
                        "signup",
                        "about",
                        "contact"
                    ].includes(
                        slug.toLowerCase()
                    );
                } catch {
                    return false;
                }
            });

        let best = null;
        let bestScore = -1;

        for (const item of candidates) {
            let slug = "";

            try {
                slug =
                    new URL(item.href)
                        .pathname
                        .split("/")
                        .filter(Boolean)[0] || "";
            } catch {}

            const textTitle =
                normalizeTitle(item.text);

            const urlTitle =
                normalizeTitle(slug);

            let score = 0;

            if (
                textTitle === wanted
            ) {
                score += 200;
            }

            if (
                urlTitle === wanted
            ) {
                score += 180;
            }

            if (
                textTitle.includes(wanted)
            ) {
                score += 100;
            }

            if (
                urlTitle.includes(wanted)
            ) {
                score += 90;
            }

            if (
                wanted.includes(textTitle) &&
                textTitle.length > 2
            ) {
                score += 60;
            }

            if (score > bestScore) {
                bestScore = score;

                best = {
                    title:
                        item.text ||
                        query,

                    url:
                        item.href,

                    slug:
                        slug
                };
            }
        }

        if (
            best &&
            bestScore >= 40
        ) {
            return best;
        }
    }

    /*
     * Final direct-slug fallback.
     *
     * This is NOT used as the primary search method;
     * it is only a fallback when the search page
     * isn't available.
     */
    const guessedSlug =
        slugify(query);

    if (guessedSlug) {
        const directUrl =
            `${BASE_URL}/${guessedSlug}`;

        try {
            const html =
                await request(directUrl);

            /*
             * Check that the page isn't a generic
             * 404/error page.
             */
            if (
                html &&
                typeof html === "string" &&
                !/404|page not found/i.test(
                    html
                )
            ) {
                return {
                    title: query,
                    url: directUrl,
                    slug: guessedSlug
                };
            }
        } catch {}
    }

    return null;
}

/* -------------------------------------------------- */
/* Chapter discovery                                   */
/* -------------------------------------------------- */

async function findChapterFromMangaPage(
    mangaHtml,
    chapter
) {
    const links =
        extractLinks(mangaHtml);

    const wanted =
        String(chapter).trim();

    const matches = [];

    for (const item of links) {
        /*
         * MangaK reader links can change over
         * time, so don't depend on one exact
         * path format.
         */
        if (
            !item.href.includes(
                "mangak.io"
            )
        ) {
            continue;
        }

        const combined =
            `${item.href} ${item.text}`;

        const number =
            extractChapterNumber(
                combined
            );

        if (!number) {
            continue;
        }

        if (
            chaptersEqual(
                number,
                wanted
            )
        ) {
            matches.push(item);
        }
    }

    if (!matches.length) {
        return null;
    }

    /*
     * Remove duplicates.
     */
    const seen = new Set();

    for (const item of matches) {
        if (seen.has(item.href)) {
            continue;
        }

        seen.add(item.href);

        return item.href;
    }

    return null;
}

/* -------------------------------------------------- */
/* Main                                                */
/* -------------------------------------------------- */

async function getChapter(
    title,
    chapter
) {
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
     * Search by title.
     */
    const manga =
        await searchManga(
            wantedTitle
        );

    if (!manga) {
        throw new Error(
            `Manga "${wantedTitle}" not found on MangaK.`
        );
    }

    /*
     * Open manga page.
     */
    const mangaHtml =
        await request(
            manga.url
        );

    /*
     * First try to locate the requested
     * chapter from the actual chapter links.
     */
    let chapterUrl =
        await findChapterFromMangaPage(
            mangaHtml,
            wantedChapter
        );

    /*
     * Current MangaK reader URLs can follow
     * a predictable /read/... structure.
     *
     * We only use this if the actual manga page
     * didn't expose the chapter link.
     */
    if (!chapterUrl) {
        const slug =
            manga.slug ||
            slugify(wantedTitle);

        const possibleUrls = [
            `${BASE_URL}/${slug}/chapter-${encodeURIComponent(wantedChapter)}`,
            `${BASE_URL}/${slug}/chapter/${encodeURIComponent(wantedChapter)}`,
            `${BASE_URL}/read/${slug}/chapter-${encodeURIComponent(wantedChapter)}`,
            `${BASE_URL}/read/${slug}/chapter/${encodeURIComponent(wantedChapter)}`
        ];

        for (const url of possibleUrls) {
            try {
                const html =
                    await request(
                        url,
                        manga.url
                    );

                if (
                    html &&
                    typeof html === "string" &&
                    !/404|page not found/i.test(
                        html
                    )
                ) {
                    chapterUrl = url;
                    break;
                }
            } catch {}
        }
    }

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${wantedChapter} not found on MangaK.`
        );
    }

    /*
     * Open chapter reader.
     */
    const chapterHtml =
        await request(
            chapterUrl,
            manga.url
        );

    /*
     * Extract all page images.
     */
    let pages =
        extractImages(
            chapterHtml
        );

    /*
     * Remove duplicates while preserving
     * original page order.
     */
    pages =
        [...new Set(pages)];

    if (!pages.length) {
        throw new Error(
            "MangaK chapter contained no readable page images."
        );
    }

    return {
        title:
            manga.title ||
            wantedTitle,

        chapter:
            wantedChapter,

        source:
            "MangaK",

        pages
    };
}

/* -------------------------------------------------- */
/* Export                                              */
/* -------------------------------------------------- */

module.exports = {
    name: "MangaK",

    async getChapter(
        title,
        chapter
    ) {
        return await getChapter(
            title,
            chapter
        );
    }
};
