const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangapark.io";

/*
 * MangaPark's certificate chain can sometimes fail on Render.
 * Keep the TLS workaround isolated to MangaPark only.
 */
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
    const links = [];

    const regex =
        /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const href = absoluteUrl(match[1]);
        const text = cleanText(match[2]);

        if (!href) continue;

        links.push({
            href,
            text
        });
    }

    return links;
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

function extractImageUrls(html) {
    const results = [];
    const seen = new Set();

    function add(url) {
        if (!url) return;

        url = absoluteUrl(url);

        if (!url) return;

        /*
         * Ignore obvious non-page images.
         */
        if (
            /favicon|logo|avatar|icon|sprite|banner|advertisement/i.test(
                url
            )
        ) {
            return;
        }

        /*
         * MangaPark may use image URLs with query strings.
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

    /*
     * Normal image attributes.
     */
    const srcRegex =
        /\b(?:src|data-src|data-original|data-lazy-src|data-image)=["']([^"']+)["']/gi;

    let match;

    while ((match = srcRegex.exec(html))) {
        add(match[1]);
    }

    /*
     * srcset images.
     */
    const srcsetRegex =
        /\bsrcset=["']([^"']+)["']/gi;

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
     * JSON-escaped image URLs.
     */
    const escapedImageRegex =
        /https?:\\?\/\\?\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s]*)?/gi;

    while ((match = escapedImageRegex.exec(html))) {
        add(
            match[0]
                .replace(/\\\//g, "/")
                .replace(/\\"/g, '"')
        );
    }

    return results;
}

async function request(url) {
    try {
        const response = await axios.get(url, {
            headers: HEADERS,

            /*
             * MangaPark certificate workaround.
             */
            httpsAgent,

            timeout: 30000,

            maxRedirects: 8,

            validateStatus: status =>
                status >= 200 && status < 400
        });

        return response.data;
    } catch (error) {
        if (error.response) {
            throw new Error(
                `HTTP ${error.response.status} from MangaPark`
            );
        }

        if (error.code === "ECONNABORTED") {
            throw new Error("MangaPark request timed out.");
        }

        throw new Error(
            error.message || "MangaPark request failed."
        );
    }
}

async function searchManga(title) {
    const query = String(title || "").trim();

    if (!query) {
        return null;
    }

    /*
     * MangaPark search.
     */
    const searchUrl =
        `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`;

    const html = await request(searchUrl);

    const links = extractLinks(html);

    const mangaLinks = links.filter(item => {
        return /\/title\//i.test(item.href);
    });

    if (!mangaLinks.length) {
        return null;
    }

    const wanted = normalizeTitle(query);

    let best = null;
    let bestScore = -1;

    for (const item of mangaLinks) {
        const textTitle = normalizeTitle(item.text);

        let hrefTitle = "";

        try {
            const pathname =
                new URL(item.href).pathname;

            hrefTitle = normalizeTitle(
                pathname
                    .split("/")
                    .filter(Boolean)
                    .pop() || ""
            );
        } catch {
            hrefTitle = "";
        }

        let score = 0;

        if (textTitle === wanted) {
            score += 100;
        }

        if (hrefTitle === wanted) {
            score += 90;
        }

        if (
            textTitle.includes(wanted) ||
            wanted.includes(textTitle)
        ) {
            score += 50;
        }

        if (
            hrefTitle.includes(wanted) ||
            wanted.includes(hrefTitle)
        ) {
            score += 40;
        }

        /*
         * Prefer actual title pages over generic pages.
         */
        if (/\/title\/[^/?#]+/i.test(item.href)) {
            score += 10;
        }

        if (score > bestScore) {
            bestScore = score;

            best = {
                title: item.text || query,
                url: item.href
            };
        }
    }

    return best;
}

async function getChapter(title, chapter) {
    const wantedTitle = String(title || "").trim();
    const wantedChapter = String(chapter || "").trim();

    if (!wantedTitle) {
        throw new Error("Manga title is required.");
    }

    if (!wantedChapter) {
        throw new Error("Chapter number is required.");
    }

    /*
     * Find manga.
     */
    const manga = await searchManga(wantedTitle);

    if (!manga) {
        throw new Error(
            `Manga "${wantedTitle}" not found on MangaPark.`
        );
    }

    /*
     * Open manga page.
     */
    const mangaHtml = await request(manga.url);

    const links = extractLinks(mangaHtml);

    /*
     * Find matching chapter links.
     */
    const chapterLinks = links.filter(item => {
        const combined =
            `${item.href} ${item.text}`;

        /*
         * MangaPark chapter URL patterns.
         */
        if (
            !/\/title\/.*?(?:chapter|ch)[-_]/i.test(
                item.href
            )
        ) {
            return false;
        }

        const number =
            chapterNumberFromText(combined);

        if (!number) {
            return false;
        }

        return numberEquals(
            number,
            wantedChapter
        );
    });

    /*
     * If the normal chapter pattern did not work,
     * perform a broader scan.
     */
    let candidates = chapterLinks;

    if (!candidates.length) {
        candidates = links.filter(item => {
            const combined =
                `${item.href} ${item.text}`;

            if (
                !/chapter|chap|ch/i.test(combined)
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

    if (!candidates.length) {
        throw new Error(
            `Chapter ${wantedChapter} not found on MangaPark.`
        );
    }

    /*
     * Remove duplicate chapter URLs.
     */
    const unique = [];
    const seen = new Set();

    for (const item of candidates) {
        if (seen.has(item.href)) {
            continue;
        }

        seen.add(item.href);
        unique.push(item);
    }

    /*
     * Open chapter page.
     */
    const chapterPage = unique[0];

    const chapterHtml =
        await request(chapterPage.href);

    /*
     * Extract manga pages.
     */
    let pages =
        extractImageUrls(chapterHtml);

    pages = [...new Set(pages)];

    /*
     * Remove very small obvious site images.
     */
    pages = pages.filter(url => {
        return !/logo|favicon|avatar|icon|sprite/i.test(
            url
        );
    });

    if (!pages.length) {
        throw new Error(
            "MangaPark chapter page contained no readable images."
        );
    }

    return {
        title:
            cleanText(manga.title) ||
            wantedTitle,

        chapter: wantedChapter,

        source: "MangaPark",

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
