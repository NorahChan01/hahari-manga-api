const axios = require("axios");

const BASE_URL = "https://mangapark.io";

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/139.0.0.0 Safari/537.36",
    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache"
};

function cleanText(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
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

function escapeRegex(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function absoluteUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/g, "&")
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
        /\bch[\s._-]*(\d+(?:\.\d+)?)/i,
        /[-_]ch[-_](\d+(?:\.\d+)?)/i,
        /[-_]chapter[-_](\d+(?:\.\d+)?)/i
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

    return String(a) === String(b);
}

function extractImageUrls(html) {
    const results = [];
    const seen = new Set();

    function add(url) {
        if (!url) return;

        url = absoluteUrl(url);

        if (!url) return;

        // Ignore obvious non-page images.
        if (
            /favicon|logo|avatar|icon|sprite|banner/i.test(url)
        ) {
            return;
        }

        // MangaPark reader images are normally image files.
        if (
            !/\.(?:jpg|jpeg|png|webp|gif)(?:[?#]|$)/i.test(url)
        ) {
            return;
        }

        if (seen.has(url)) return;

        seen.add(url);
        results.push(url);
    }

    // Normal src attributes.
    const srcRegex =
        /\b(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["']/gi;

    let match;

    while ((match = srcRegex.exec(html))) {
        add(match[1]);
    }

    // srcset attributes.
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

    return results;
}

async function request(url) {
    const response = await axios.get(url, {
        headers: HEADERS,
        timeout: 25000,
        maxRedirects: 5,
        validateStatus: status =>
            status >= 200 && status < 400
    });

    return response.data;
}

async function searchManga(title) {
    const query = String(title || "").trim();

    if (!query) {
        return null;
    }

    const url =
        `${BASE_URL}/search?keyword=${encodeURIComponent(query)}`;

    const html = await request(url);

    const links = extractLinks(html);

    const mangaLinks = links.filter(item => {
        return /\/title\/[^/?#]+/i.test(item.href);
    });

    if (!mangaLinks.length) {
        return null;
    }

    const wanted = normalizeTitle(query);

    let best = null;
    let bestScore = -1;

    for (const item of mangaLinks) {
        const titleFromText =
            normalizeTitle(item.text);

        const hrefTitle =
            normalizeTitle(
                item.href
                    .split("/")
                    .pop()
                    .replace(/-\d+$/, "")
            );

        let score = 0;

        if (titleFromText === wanted) {
            score += 100;
        }

        if (hrefTitle === wanted) {
            score += 90;
        }

        if (
            titleFromText.includes(wanted) ||
            wanted.includes(titleFromText)
        ) {
            score += 50;
        }

        if (
            hrefTitle.includes(wanted) ||
            wanted.includes(hrefTitle)
        ) {
            score += 40;
        }

        if (score > bestScore) {
            bestScore = score;
            best = {
                title:
                    item.text ||
                    query,
                url: item.href
            };
        }
    }

    return best;
}

async function getChapter(title, chapter) {
    const manga = await searchManga(title);

    if (!manga) {
        throw new Error("Manga not found on MangaPark.");
    }

    const mangaHtml = await request(manga.url);

    const links = extractLinks(mangaHtml);

    const wantedChapter = String(chapter).trim();

    const chapterLinks = links.filter(item => {
        if (
            !/\/title\/[^/?#]+-(?:ch|chapter)-/i.test(
                item.href
            )
        ) {
            return false;
        }

        const number =
            chapterNumberFromText(
                `${item.href} ${item.text}`
            );

        return (
            number &&
            numberEquals(
                number,
                wantedChapter
            )
        );
    });

    if (!chapterLinks.length) {
        throw new Error(
            `Chapter ${wantedChapter} not found on MangaPark.`
        );
    }

    // Prefer the first unique chapter URL.
    const unique = [];

    const seen = new Set();

    for (const item of chapterLinks) {
        if (seen.has(item.href)) continue;

        seen.add(item.href);
        unique.push(item);
    }

    const chapterPage = unique[0];

    const chapterHtml =
        await request(chapterPage.href);

    let pages =
        extractImageUrls(chapterHtml);

    /*
     * MangaPark can expose several versions of the
     * same image URL through src/data-src/srcset.
     *
     * Remove duplicates while preserving order.
     */
    pages = [...new Set(pages)];

    if (!pages.length) {
        throw new Error(
            "MangaPark chapter page contained no readable images."
        );
    }

    return {
        title:
            manga.title ||
            title,
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
        return await getChapter(title, chapter);
    }
};
