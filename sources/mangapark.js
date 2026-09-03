const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangapark1.com";

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

function extractTitleFromUrl(url) {
    try {
        const parsed = new URL(url);

        const parts = parsed.pathname
            .split("/")
            .filter(Boolean);

        if (!parts.length) return "";

        return decodeURIComponent(
            parts[parts.length - 1]
        )
            .replace(/[-_]+/g, " ")
            .replace(/\b(?:chapter|chap|ch)\b.*$/i, "")
            .replace(/\b\d+(?:\.\d+)?\b.*$/i, "")
            .trim();
    } catch {
        return "";
    }
}

function chapterNumberFromText(value) {
    const text = String(value || "");

    const patterns = [
        /\bchapter[\s._-]*(\d+(?:\.\d+)?)/i,
        /\bchap[\s._-]*(\d+(?:\.\d+)?)/i,
        /\bch[\s._-]*(\d+(?:\.\d+)?)/i,
        /[-_]chapter[-_](\d+(?:\.\d+)?)/i,
        /[-_]ch[-_](\d+(?:\.\d+)?)/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);

        if (match) {
            return match[1];
        }
    }

    return null;
}

function numberEquals(a, b) {
    const na = Number(a);
    const nb = Number(b);

    if (Number.isFinite(na) && Number.isFinite(nb)) {
        return na === nb;
    }

    return String(a).trim() === String(b).trim();
}

function extractImages(html) {
    const images = [];
    const seen = new Set();

    function add(url) {
        if (!url) return;

        url = absoluteUrl(url);

        if (!url) return;

        if (
            /favicon|logo|avatar|icon|sprite|banner|ads?|advert/i.test(
                url
            )
        ) {
            return;
        }

        if (
            !/\.(?:jpg|jpeg|png|webp|gif)(?:[?#]|$)/i.test(
                url
            )
        ) {
            return;
        }

        if (seen.has(url)) return;

        seen.add(url);
        images.push(url);
    }

    let match;

    /*
     * Normal image attributes.
     */
    const imageRegex =
        /<(?:img|source)\b[^>]*?(?:src|data-src|data-original|data-lazy-src|data-image|data-url)\s*=\s*["']([^"']+)["']/gi;

    while ((match = imageRegex.exec(html))) {
        add(match[1]);
    }

    /*
     * srcset.
     */
    const srcsetRegex =
        /\bsrcset\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcsetRegex.exec(html))) {
        for (const part of match[1].split(",")) {
            add(part.trim().split(/\s+/)[0]);
        }
    }

    /*
     * Direct image URLs embedded in scripts/JSON.
     */
    const directUrlRegex =
        /https?:\\?\/\\?\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s]*)?/gi;

    while ((match = directUrlRegex.exec(html))) {
        add(match[0]);
    }

    return images;
}

async function request(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                ...HEADERS,
                Referer: BASE_URL + "/"
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

        throw new Error(
            error.message || "Request failed"
        );
    }
}

async function searchManga(title) {
    const query = String(title || "").trim();

    if (!query) return null;

    /*
     * Current MangaPark search format.
     */
    const searchUrls = [
        `${BASE_URL}/search?q=${encodeURIComponent(query)}&page=1`,
        `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`,
        `${BASE_URL}/search/${encodeURIComponent(query)}`
    ];

    let html = "";

    let lastError = null;

    for (const url of searchUrls) {
        try {
            html = await request(url);

            if (html && typeof html === "string") {
                if (
                    /one piece/i.test(html) ||
                    /\/manga\//i.test(html) ||
                    /\/title\//i.test(html) ||
                    /search/i.test(html)
                ) {
                    break;
                }
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (!html) {
        throw lastError ||
            new Error("MangaPark search failed.");
    }

    const links = extractLinks(html);

    const mangaLinks = links.filter(item => {
        return (
            /\/(?:manga|title)\//i.test(item.href)
        );
    });

    if (!mangaLinks.length) {
        return null;
    }

    const wanted = normalizeTitle(query);

    let best = null;
    let bestScore = -1;

    for (const item of mangaLinks) {
        const visibleTitle =
            normalizeTitle(item.text);

        const urlTitle =
            normalizeTitle(
                extractTitleFromUrl(item.href)
            );

        let score = 0;

        if (visibleTitle === wanted) {
            score += 200;
        }

        if (urlTitle === wanted) {
            score += 180;
        }

        if (
            visibleTitle.includes(wanted) ||
            wanted.includes(visibleTitle)
        ) {
            score += 100;
        }

        if (
            urlTitle.includes(wanted) ||
            wanted.includes(urlTitle)
        ) {
            score += 90;
        }

        /*
         * Prefer links whose text actually resembles
         * the requested manga.
         */
        if (
            visibleTitle.includes("one piece") &&
            wanted.includes("one piece")
        ) {
            score += 50;
        }

        if (score > bestScore) {
            bestScore = score;

            best = {
                title:
                    item.text ||
                    extractTitleFromUrl(item.href) ||
                    query,

                url: item.href
            };
        }
    }

    /*
     * Don't return a completely unrelated manga.
     */
    if (!best || bestScore < 40) {
        return null;
    }

    return best;
}

async function getChapter(title, chapter) {
    const wantedTitle =
        String(title || "").trim();

    const wantedChapter =
        String(chapter || "").trim();

    if (!wantedTitle) {
        throw new Error("Manga title is required.");
    }

    if (!wantedChapter) {
        throw new Error("Chapter number is required.");
    }

    /*
     * Search manga.
     */
    const manga =
        await searchManga(wantedTitle);

    if (!manga) {
        throw new Error(
            `Manga "${wantedTitle}" not found on MangaPark.`
        );
    }

    /*
     * Open manga page.
     */
    const mangaHtml =
        await request(manga.url);

    const links =
        extractLinks(mangaHtml);

    /*
     * Find chapter links.
     */
    let chapterLinks =
        links.filter(item => {
            const combined =
                `${item.href} ${item.text}`;

            const number =
                chapterNumberFromText(combined);

            return (
                number &&
                numberEquals(
                    number,
                    wantedChapter
                )
            );
        });

    /*
     * Some MangaPark pages may have chapter
     * information in URL patterns that don't
     * contain the literal word "chapter".
     */
    if (!chapterLinks.length) {
        chapterLinks =
            links.filter(item => {
                const combined =
                    `${item.href} ${item.text}`;

                if (
                    !/\/(?:chapter|chap|ch)[\/_-]/i.test(
                        item.href
                    )
                ) {
                    return false;
                }

                const number =
                    chapterNumberFromText(combined);

                return (
                    number &&
                    numberEquals(
                        number,
                        wantedChapter
                    )
                );
            });
    }

    if (!chapterLinks.length) {
        throw new Error(
            `Chapter ${wantedChapter} not found on MangaPark.`
        );
    }

    /*
     * Remove duplicates.
     */
    const unique = [];
    const seen = new Set();

    for (const item of chapterLinks) {
        if (seen.has(item.href)) {
            continue;
        }

        seen.add(item.href);
        unique.push(item);
    }

    /*
     * Use first matching chapter.
     */
    const chapterUrl =
        unique[0].href;

    const chapterHtml =
        await request(chapterUrl);

    let pages =
        extractImages(chapterHtml);

    pages = [...new Set(pages)];

    if (!pages.length) {
        throw new Error(
            "MangaPark chapter contained no readable images."
        );
    }

    return {
        title:
            manga.title ||
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
