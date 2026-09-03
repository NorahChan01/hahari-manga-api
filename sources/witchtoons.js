const axios = require("axios");
const https = require("https");

const BASE_URL = "https://witchtoons.net";

const agent = new https.Agent({
    rejectUnauthorized: false
});

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
};

function cleanText(value) {
    return String(value || "")
        .replace(/\\u003c/gi, "<")
        .replace(/\\u003e/gi, ">")
        .replace(/\\u002f/gi, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\\r/g, " ")
        .replace(/\\t/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTitle(value) {
    return cleanText(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function slugify(value) {
    return normalizeTitle(value)
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function absoluteUrl(url) {
    if (!url) return null;

    url = cleanText(url);

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

async function request(url) {
    const response = await axios.get(url, {
        httpsAgent: agent,
        headers: HEADERS,
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: status =>
            status >= 200 && status < 400
    });

    return {
        html: String(response.data || ""),
        finalUrl:
            response.request?.res?.responseUrl || url
    };
}

function decodeRSC(html) {
    let out = String(html || "");

    const replacements = [
        [/\\u002F/gi, "/"],
        [/\\u002f/gi, "/"],
        [/\\u002D/gi, "-"],
        [/\\u002d/gi, "-"],
        [/\\u003C/gi, "<"],
        [/\\u003c/gi, "<"],
        [/\\u003E/gi, ">"],
        [/\\u003e/gi, ">"],
        [/\\u0026/gi, "&"],
        [/\\u0026/gi, "&"],
        [/\\u003F/gi, "?"],
        [/\\u003f/gi, "?"],
        [/\\u003D/gi, "="],
        [/\\u003d/gi, "="],
        [/\\"/g, '"']
    ];

    for (const [regex, replacement] of replacements) {
        out = out.replace(regex, replacement);
    }

    return out;
}

function extractTitle(html, fallback) {
    const decoded = decodeRSC(html);

    const patterns = [
        /<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i,

        /<title[^>]*>\s*([^<]+?)\s*<\/title>/i,

        /"title"\s*:\s*"([^"]+)"/i,

        /"name"\s*:\s*"([^"]+)"/i,

        /\\"title\\"\s*:\s*\\"([^"\\]+)\\"/i,

        /\\"name\\"\s*:\s*\\"([^"\\]+)\\"/i
    ];

    for (const regex of patterns) {
        const match =
            decoded.match(regex) ||
            html.match(regex);

        if (!match) continue;

        let title = cleanText(match[1]);

        title = title
            .replace(/\s*\|\s*WitchToons.*$/i, "")
            .replace(/\s*-\s*WitchToons.*$/i, "")
            .trim();

        if (
            title &&
            title.length > 1 &&
            !/^witchtoons$/i.test(title)
        ) {
            return title;
        }
    }

    return fallback;
}

function chapterNumber(value) {
    if (!value) return null;

    const text = decodeURIComponent(
        String(value)
            .replace(/\\u002F/gi, "/")
            .replace(/\\u002D/gi, "-")
    );

    const patterns = [
        /\/chapter\/(\d+(?:\.\d+)?)/i,
        /chapter[-_ ](\d+(?:\.\d+)?)/i,
        /\bchapter\s*(\d+(?:\.\d+)?)\b/i,
        /\bch\.?\s*(\d+(?:\.\d+)?)\b/i
    ];

    for (const regex of patterns) {
        const match = text.match(regex);

        if (match) {
            return match[1];
        }
    }

    return null;
}

function sameChapter(a, b) {
    const x = parseFloat(String(a));
    const y = parseFloat(String(b));

    if (!Number.isNaN(x) && !Number.isNaN(y)) {
        return Math.abs(x - y) < 0.000001;
    }

    return String(a).trim() === String(b).trim();
}

/*
 * Extract chapter URLs from the RSC payload.
 */
function extractChapterLinks(html) {
    const decoded = decodeRSC(html);

    const combined =
        html + "\n" + decoded;

    const results = [];
    const seen = new Set();

    const regexes = [
        /\/series\/comic\/[^"'\\\s]+\/chapter\/[^"'\\\s]+/gi,

        /https?:\/\/witchtoons\.net\/series\/comic\/[^"'\\\s]+\/chapter\/[^"'\\\s]+/gi
    ];

    for (const regex of regexes) {
        let match;

        while ((match = regex.exec(combined))) {
            let url = match[0];

            url = url
                .replace(/\\u002F/gi, "/")
                .replace(/\\u002D/gi, "-")
                .replace(/\\"/g, "");

            url =
                absoluteUrl(url) ||
                url;

            if (!url) continue;

            const cleanUrl =
                url.split("?")[0].split("#")[0];

            const ch =
                chapterNumber(cleanUrl);

            if (ch === null) continue;

            if (seen.has(cleanUrl)) continue;

            seen.add(cleanUrl);

            results.push({
                url: cleanUrl,
                chapter: ch
            });
        }
    }

    return results;
}

/*
 * Extract reader image URLs.
 */
function extractImages(html) {
    const decoded = decodeRSC(html);

    const combined =
        html + "\n" + decoded;

    const images = [];
    const seen = new Set();

    const regexes = [
        /<img[^>]+src=["']([^"']+)["']/gi,

        /<img[^>]+data-src=["']([^"']+)["']/gi,

        /<img[^>]+data-lazy-src=["']([^"']+)["']/gi,

        /"src"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"]*)?)"/gi,

        /"image"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"]*)?)"/gi,

        /"imageUrl"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"]*)?)"/gi,

        /\\"src\\"\s*:\s*\\"([^"\\]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"\\]*)?)\\"/gi,

        /\\"image\\"\s*:\s*\\"([^"\\]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"\\]*)?)\\"/gi,

        /\\"imageUrl\\"\s*:\s*\\"([^"\\]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"\\]*)?)\\"/gi
    ];

    for (const regex of regexes) {
        let match;

        while ((match = regex.exec(combined))) {
            let url = match[1];

            url = url
                .replace(/\\u002F/gi, "/")
                .replace(/\\u0026/gi, "&")
                .replace(/\\"/g, "");

            url =
                absoluteUrl(url) ||
                url;

            if (!url) continue;

            if (
                !/\.(jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(url)
            ) {
                continue;
            }

            const lower = url.toLowerCase();

            /*
             * Do not return covers/thumbnails.
             */
            if (
                lower.includes("/cover/") ||
                lower.includes("/covers/") ||
                lower.includes("/thumbnail") ||
                lower.includes("/thumb/") ||
                lower.includes("/thumbs/")
            ) {
                continue;
            }

            if (!seen.has(url)) {
                seen.add(url);
                images.push(url);
            }
        }
    }

    return images;
}

/*
 * Search by predictable slug FIRST.
 *
 * This is important because WitchToons' current search
 * interface is rendered through Next.js and may not expose
 * its results as normal HTML links.
 */
async function searchManga(title) {
    const wanted = cleanText(title);

    if (!wanted) {
        return null;
    }

    const slug = slugify(wanted);

    /*
     * Known direct series URL.
     */
    const directUrl =
        `${BASE_URL}/series/comic/${slug}`;

    try {
        const page =
            await request(directUrl);

        if (
            page.html &&
            page.html.length > 500
        ) {
            const realTitle =
                extractTitle(
                    page.html,
                    wanted
                );

            /*
             * Don't reject merely because the title
             * formatting differs.
             */
            return {
                url: directUrl,
                title:
                    realTitle || wanted
            };
        }
    } catch (_) {}

    /*
     * Search fallbacks.
     */
    const searchUrls = [
        `${BASE_URL}/series?search=${encodeURIComponent(wanted)}`,
        `${BASE_URL}/series?keyword=${encodeURIComponent(wanted)}`,
        `${BASE_URL}/search?q=${encodeURIComponent(wanted)}`,
        `${BASE_URL}/search?keyword=${encodeURIComponent(wanted)}`
    ];

    let best = null;
    let bestScore = 0;

    for (const searchUrl of searchUrls) {
        try {
            const page =
                await request(searchUrl);

            const decoded =
                decodeRSC(page.html);

            const combined =
                page.html + "\n" + decoded;

            const regex =
                /\/series\/comic\/([a-z0-9-]+)/gi;

            let match;

            while ((match = regex.exec(combined))) {
                const candidateUrl =
                    `${BASE_URL}/series/comic/${match[1]}`;

                let candidateTitle =
                    match[1]
                        .replace(/-/g, " ");

                try {
                    const candidate =
                        await request(candidateUrl);

                    candidateTitle =
                        extractTitle(
                            candidate.html,
                            candidateTitle
                        );
                } catch (_) {}

                const a =
                    normalizeTitle(candidateTitle);

                const b =
                    normalizeTitle(wanted);

                let score = 0;

                if (a === b) {
                    score = 100;
                } else if (
                    a.includes(b) ||
                    b.includes(a)
                ) {
                    score = 75;
                } else {
                    const aw =
                        new Set(a.split(" "));

                    const bw =
                        b.split(" ");

                    for (const word of bw) {
                        if (aw.has(word)) {
                            score += 10;
                        }
                    }
                }

                if (score > bestScore) {
                    bestScore = score;

                    best = {
                        url: candidateUrl,
                        title: candidateTitle
                    };
                }
            }

            if (bestScore >= 100) {
                return best;
            }
        } catch (_) {}
    }

    return best;
}

/*
 * Find exact chapter.
 */
async function findChapter(
    seriesHtml,
    seriesUrl,
    requestedChapter
) {
    const chapters =
        extractChapterLinks(seriesHtml);

    /*
     * Exact chapter from RSC.
     */
    for (const item of chapters) {
        if (
            sameChapter(
                item.chapter,
                requestedChapter
            )
        ) {
            return item.url;
        }
    }

    /*
     * Direct chapter URL.
     *
     * Current WitchToons structure:
     * /series/comic/{slug}/chapter/{number}
     */
    const match =
        seriesUrl.match(
            /\/series\/comic\/([^/]+)\/?$/i
        );

    if (!match) {
        return null;
    }

    const slug = match[1];

    const direct =
        `${BASE_URL}/series/comic/${slug}/chapter/${requestedChapter}`;

    try {
        const page =
            await request(direct);

        /*
         * A real reader page should contain
         * substantially more than an error page.
         */
        if (
            page.html &&
            page.html.length > 1000 &&
            !/page not found|404 not found/i.test(
                page.html
            )
        ) {
            return direct;
        }
    } catch (_) {}

    return null;
}

async function getChapter(
    title,
    chapter
) {
    const wantedTitle =
        cleanText(title);

    const wantedChapter =
        cleanText(chapter);

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
     * 1. Find series.
     */
    const manga =
        await searchManga(wantedTitle);

    if (!manga) {
        throw new Error(
            `Manga not found on WitchToons: ${wantedTitle}`
        );
    }

    /*
     * 2. Get series page.
     */
    const seriesPage =
        await request(manga.url);

    /*
     * 3. Find chapter.
     */
    const chapterUrl =
        await findChapter(
            seriesPage.html,
            manga.url,
            wantedChapter
        );

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${wantedChapter} not found on WitchToons.`
        );
    }

    /*
     * 4. Open reader.
     */
    const reader =
        await request(chapterUrl);

    /*
     * 5. Extract pages.
     */
    const pages =
        extractImages(reader.html);

    if (!pages.length) {
        throw new Error(
            `No reader pages found for ${wantedTitle} chapter ${wantedChapter}.`
        );
    }

    /*
     * Remove duplicates while preserving
     * original page order.
     */
    const uniquePages =
        [...new Set(pages)];

    return {
        title:
            manga.title ||
            wantedTitle,

        chapter:
            wantedChapter,

        source:
            "WitchToons",

        pages:
            uniquePages
    };
}

module.exports = {
    name: "WitchToons",

    async getChapter(title, chapter) {
        return await getChapter(
            title,
            chapter
        );
    }
};
