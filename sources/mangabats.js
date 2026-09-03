const axios = require("axios");
const https = require("https");

const BASE_URL = "https://www.mangabats.com";

const agent = new https.Agent({
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

    "Referer":
        BASE_URL + "/"
};

function cleanText(value) {
    return String(value || "")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&nbsp;/gi, " ")
        .replace(/\\u002F/gi, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\u003D/gi, "=")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\\r/g, " ")
        .replace(/\\t/g, " ")
        .replace(/<[^>]+>/g, " ")
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

    url = String(url)
        .replace(/\\u002F/gi, "/")
        .replace(/\\u0026/gi, "&")
        .replace(/\\"/g, "")
        .trim();

    if (!url) return null;

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

async function request(url, extraHeaders = {}) {
    const response = await axios.get(url, {
        httpsAgent: agent,

        headers: {
            ...HEADERS,
            ...extraHeaders
        },

        timeout: 30000,

        maxRedirects: 5,

        validateStatus: status =>
            status >= 200 && status < 400
    });

    return {
        html: String(response.data || ""),

        finalUrl:
            response.request?.res?.responseUrl ||
            url,

        status:
            response.status
    };
}

/*
 * Extract all href values from HTML.
 */
function extractLinks(html) {
    const links = [];
    const seen = new Set();

    const regexes = [
        /href\s*=\s*["']([^"']+)["']/gi,
        /\\"href\\"\s*:\s*\\"([^"\\]+)\\"/gi
    ];

    for (const regex of regexes) {
        let match;

        while ((match = regex.exec(html))) {
            const url = absoluteUrl(match[1]);

            if (!url) continue;

            const cleanUrl =
                url.split("#")[0];

            if (!seen.has(cleanUrl)) {
                seen.add(cleanUrl);
                links.push(cleanUrl);
            }
        }
    }

    return links;
}

/*
 * Extract title from a manga page.
 */
function extractTitle(html, fallback) {
    const patterns = [
        /<h1[^>]*>([\s\S]*?)<\/h1>/i,

        /<h2[^>]*class=["'][^"']*(?:story|manga)[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i,

        /<title[^>]*>([\s\S]*?)<\/title>/i
    ];

    for (const regex of patterns) {
        const match = html.match(regex);

        if (!match) continue;

        let title = cleanText(match[1]);

        title = title
            .replace(/\s*\|\s*Mangabat.*$/i, "")
            .replace(/\s*-\s*Mangabat.*$/i, "")
            .replace(/\s*\|\s*MangaBats.*$/i, "")
            .replace(/\s*-\s*MangaBats.*$/i, "")
            .trim();

        if (
            title &&
            title.length > 1 &&
            !/^(home|mangabat|mangabats)$/i.test(title)
        ) {
            return title;
        }
    }

    return fallback;
}

/*
 * Extract manga links.
 *
 * MangaBats currently uses:
 *
 * /manga/one-piece
 *
 * We intentionally don't invent a slug.
 * Search results are preferred.
 */
function extractMangaCandidates(html) {
    const results = [];
    const seen = new Set();

    const regexes = [
        /href\s*=\s*["'](\/manga\/[^"'?#]+)["']/gi,

        /\\"href\\"\s*:\s*\\"(\/manga\/[^"\\?#]+)\\"/gi,

        /https?:\/\/(?:www\.)?mangabats\.com\/manga\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/gi
    ];

    for (const regex of regexes) {
        let match;

        while ((match = regex.exec(html))) {
            let raw =
                match[1] ||
                match[0];

            raw = raw
                .replace(/\\u002F/gi, "/")
                .replace(/\\"/g, "");

            const url =
                absoluteUrl(raw);

            if (!url) continue;

            const cleanUrl =
                url
                    .split("?")[0]
                    .split("#")[0]
                    .replace(/\/+$/, "");

            /*
             * Make sure this is exactly:
             *
             * /manga/<slug>
             *
             * and not a chapter URL.
             */
            if (
                !/^https:\/\/www\.mangabats\.com\/manga\/[^/]+$/i.test(
                    cleanUrl
                )
            ) {
                continue;
            }

            if (seen.has(cleanUrl)) {
                continue;
            }

            seen.add(cleanUrl);

            const slug =
                cleanUrl
                    .split("/")
                    .pop();

            results.push({
                url: cleanUrl,
                slug
            });
        }
    }

    return results;
}

/*
 * Score a title against the user's search.
 */
function titleScore(found, wanted) {
    const a =
        normalizeTitle(found);

    const b =
        normalizeTitle(wanted);

    if (!a || !b) {
        return 0;
    }

    if (a === b) {
        return 100;
    }

    if (
        a.includes(b) ||
        b.includes(a)
    ) {
        return 80;
    }

    const aWords =
        new Set(a.split(" "));

    const bWords =
        b.split(" ");

    let common = 0;

    for (const word of bWords) {
        if (aWords.has(word)) {
            common++;
        }
    }

    if (!bWords.length) {
        return 0;
    }

    return Math.round(
        (common / bWords.length) * 60
    );
}

/*
 * Search MangaBats.
 */
async function searchManga(title) {
    const wanted =
        cleanText(title);

    if (!wanted) {
        return null;
    }

    const query =
        encodeURIComponent(wanted);

    const searchUrls = [
        `${BASE_URL}/search?keyword=${query}`,
        `${BASE_URL}/search?q=${query}`,
        `${BASE_URL}/search/${query}`,
        `${BASE_URL}/manga-list/search?keyword=${query}`
    ];

    let best = null;
    let bestScore = 0;

    /*
     * First use the site's search.
     */
    for (const searchUrl of searchUrls) {
        try {
            const page =
                await request(searchUrl);

            const candidates =
                extractMangaCandidates(
                    page.html
                );

            for (const candidate of candidates) {
                let candidateTitle =
                    candidate.slug
                        .replace(/[-_]+/g, " ")
                        .trim();

                /*
                 * Open candidate page to obtain
                 * the actual title.
                 */
                try {
                    const mangaPage =
                        await request(
                            candidate.url
                        );

                    candidateTitle =
                        extractTitle(
                            mangaPage.html,
                            candidateTitle
                        );
                } catch (_) {}

                const score =
                    titleScore(
                        candidateTitle,
                        wanted
                    );

                if (score > bestScore) {
                    bestScore = score;

                    best = {
                        url:
                            candidate.url,

                        title:
                            candidateTitle
                    };
                }
            }

            if (bestScore >= 100) {
                return best;
            }
        } catch (_) {}
    }

    /*
     * Direct slug fallback.
     *
     * This is only a fallback. Search results
     * remain preferred because titles can have
     * unusual slugs.
     */
    const slug =
        slugify(wanted);

    const directUrls = [
        `${BASE_URL}/manga/${slug}`
    ];

    for (const url of directUrls) {
        try {
            const page =
                await request(url);

            if (
                page.html &&
                page.html.length > 1000 &&
                !/404\s+not\s+found/i.test(
                    page.html
                )
            ) {
                const realTitle =
                    extractTitle(
                        page.html,
                        wanted
                    );

                /*
                 * Only accept a direct slug when
                 * the page looks like a manga page.
                 */
                const looksLikeManga =
                    /chapter/i.test(
                        page.html
                    ) ||
                    /manga/i.test(
                        page.html
                    );

                if (looksLikeManga) {
                    return {
                        url,

                        title:
                            realTitle ||
                            wanted
                    };
                }
            }
        } catch (_) {}
    }

    return best;
}

/*
 * Find chapter URLs on the manga page.
 */
function extractChapterLinks(html) {
    const results = [];
    const seen = new Set();

    const links =
        extractLinks(html);

    for (const url of links) {
        const lower =
            url.toLowerCase();

        /*
         * MangaBats chapter URLs may contain
         * /chapter/ or /chapter- style paths.
         */
        if (
            !lower.includes("/chapter")
        ) {
            continue;
        }

        const chapter =
            extractChapterNumber(
                url
            );

        if (chapter === null) {
            continue;
        }

        const cleanUrl =
            url
                .split("#")[0]
                .replace(/\/+$/, "");

        if (seen.has(cleanUrl)) {
            continue;
        }

        seen.add(cleanUrl);

        results.push({
            url:
                cleanUrl,

            chapter
        });
    }

    return results;
}

/*
 * Extract chapter number from URL/text.
 */
function extractChapterNumber(value) {
    if (!value) {
        return null;
    }

    const text =
        decodeURIComponent(
            String(value)
                .replace(/\\u002F/gi, "/")
                .replace(/\\u002D/gi, "-")
        );

    const patterns = [
        /\/chapter[-_/](\d+(?:\.\d+)?)/i,

        /\/chapter[_-]?(\d+(?:\.\d+)?)/i,

        /chapter[-_ ]?(\d+(?:\.\d+)?)/i,

        /\bch(?:apter)?\.?\s*(\d+(?:\.\d+)?)\b/i
    ];

    for (const regex of patterns) {
        const match =
            text.match(regex);

        if (match) {
            return String(
                match[1]
            );
        }
    }

    return null;
}

/*
 * Compare chapter numbers safely.
 *
 * Handles:
 * 1
 * 1.0
 * 1.5
 * 100
 */
function sameChapter(a, b) {
    const x =
        parseFloat(
            String(a)
        );

    const y =
        parseFloat(
            String(b)
        );

    if (
        !Number.isNaN(x) &&
        !Number.isNaN(y)
    ) {
        return (
            Math.abs(x - y) <
            0.000001
        );
    }

    return (
        String(a).trim() ===
        String(b).trim()
    );
}

/*
 * Find requested chapter.
 */
async function findChapter(
    mangaHtml,
    mangaUrl,
    wantedChapter
) {
    /*
     * 1. Look through all chapter links.
     */
    const chapters =
        extractChapterLinks(
            mangaHtml
        );

    /*
     * Exact chapter match.
     */
    for (const item of chapters) {
        if (
            sameChapter(
                item.chapter,
                wantedChapter
            )
        ) {
            return item.url;
        }
    }

    /*
     * Sometimes chapter numbers appear
     * in the visible HTML but their href
     * is encoded differently.
     */
    const decoded =
        mangaHtml
            .replace(
                /\\u002F/gi,
                "/"
            )
            .replace(
                /\\u002D/gi,
                "-"
            )
            .replace(
                /\\"/g,
                '"'
            );

    const regexes = [
        new RegExp(
            `href\\s*=\\s*["']([^"']*chapter[^"']*${escapeRegex(
                wantedChapter
            )}[^"']*)["']`,
            "gi"
        ),

        new RegExp(
            `(\\/manga\\/[^\\s"'<>]+chapter[^\\s"'<>]*${escapeRegex(
                wantedChapter
            )}[^\\s"'<>]*)`,
            "gi"
        )
    ];

    for (const regex of regexes) {
        let match;

        while (
            (match =
                regex.exec(decoded))
        ) {
            const url =
                absoluteUrl(
                    match[1]
                );

            if (url) {
                return url;
            }
        }
    }

    /*
     * 2. If the chapter wasn't present in
     * the current page, try pagination.
     */
    const pageLinks =
        extractLinks(
            mangaHtml
        ).filter(url =>
            /[?&](page|p)=\d+/i.test(
                url
            )
        );

    const uniquePages =
        [...new Set(pageLinks)];

    /*
     * Check up to 10 pagination pages.
     * This prevents an accidental infinite loop.
     */
    for (
        const pageUrl of uniquePages.slice(
            0,
            10
        )
    ) {
        try {
            const page =
                await request(
                    pageUrl
                );

            const found =
                extractChapterLinks(
                    page.html
                );

            for (const item of found) {
                if (
                    sameChapter(
                        item.chapter,
                        wantedChapter
                    )
                ) {
                    return item.url;
                }
            }
        } catch (_) {}
    }

    /*
     * 3. Last predictable fallback.
     *
     * We use the actual manga URL slug,
     * not the user supplied title.
     */
    const match =
        mangaUrl.match(
            /\/manga\/([^/]+)$/i
        );

    if (!match) {
        return null;
    }

    const slug =
        match[1];

    const fallbackUrls = [
        `${BASE_URL}/chapter/${slug}-${wantedChapter}`,
        `${BASE_URL}/manga/${slug}/chapter-${wantedChapter}`,
        `${BASE_URL}/manga/${slug}/chapter/${wantedChapter}`
    ];

    for (
        const url of fallbackUrls
    ) {
        try {
            const page =
                await request(url);

            if (
                page.html &&
                page.html.length > 1000 &&
                !/404\s+not\s+found/i.test(
                    page.html
                )
            ) {
                return url;
            }
        } catch (_) {}
    }

    return null;
}

/*
 * Extract reader images.
 */
function extractImages(html) {
    const images = [];
    const seen = new Set();

    const regexes = [
        /*
         * Normal image tags.
         */
        /<img[^>]+src=["']([^"']+)["']/gi,

        /<img[^>]+data-src=["']([^"']+)["']/gi,

        /<img[^>]+data-original=["']([^"']+)["']/gi,

        /<img[^>]+data-lazy-src=["']([^"']+)["']/gi,

        /*
         * Lazy-loading attributes.
         */
        /data-image=["']([^"']+)["']/gi,

        /data-url=["']([^"']+)["']/gi,

        /*
         * JSON-style image fields.
         */
        /["'](?:src|image|imageUrl|url)["']\s*:\s*["']([^"']+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"']*)?)["']/gi,

        /\\"(?:src|image|imageUrl|url)\\"\s*:\s*\\"([^"\\]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"\\]*)?)\\"/gi
    ];

    for (
        const regex of regexes
    ) {
        let match;

        while (
            (match =
                regex.exec(html))
        ) {
            let url =
                match[1];

            url =
                url
                    .replace(
                        /\\u002F/gi,
                        "/"
                    )
                    .replace(
                        /\\u0026/gi,
                        "&"
                    )
                    .replace(
                        /\\"/g,
                        ""
                    )
                    .trim();

            if (!url) {
                continue;
            }

            url =
                absoluteUrl(url) ||
                url;

            /*
             * Must actually look like an image.
             */
            if (
                !/\.(jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(
                    url
                )
            ) {
                continue;
            }

            const lower =
                url.toLowerCase();

            /*
             * Reject obvious cover and thumbnail images.
             */
            if (
                lower.includes(
                    "/cover/"
                ) ||
                lower.includes(
                    "/covers/"
                ) ||
                lower.includes(
                    "/thumbnail"
                ) ||
                lower.includes(
                    "/thumb/"
                ) ||
                lower.includes(
                    "/thumbs/"
                ) ||
                lower.includes(
                    "logo"
                ) ||
                lower.includes(
                    "avatar"
                )
            ) {
                continue;
            }

            if (
                !seen.has(url)
            ) {
                seen.add(url);
                images.push(url);
            }
        }
    }

    /*
     * Remove duplicates while preserving order.
     */
    return [
        ...new Set(images)
    ];
}

/*
 * Validate whether an image URL is
 * probably a real reader page.
 */
function looksLikeReaderImage(url) {
    if (!url) {
        return false;
    }

    const lower =
        url.toLowerCase();

    if (
        lower.includes(
            "/cover/"
        ) ||
        lower.includes(
            "/covers/"
        ) ||
        lower.includes(
            "thumbnail"
        ) ||
        lower.includes(
            "/thumb/"
        ) ||
        lower.includes(
            "/thumbs/"
        )
    ) {
        return false;
    }

    return true;
}

/*
 * Main source method.
 */
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
     * 1. Search manga.
     */
    const manga =
        await searchManga(
            wantedTitle
        );

    if (!manga) {
        throw new Error(
            `Manga not found on MangaBats: ${wantedTitle}`
        );
    }

    /*
     * 2. Open manga page.
     */
    const mangaPage =
        await request(
            manga.url
        );

    /*
     * 3. Find exact chapter.
     */
    const chapterUrl =
        await findChapter(
            mangaPage.html,
            manga.url,
            wantedChapter
        );

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${wantedChapter} not found on MangaBats.`
        );
    }

    /*
     * 4. Open chapter reader.
     */
    const chapterPage =
        await request(
            chapterUrl,
            {
                Referer:
                    manga.url
            }
        );

    /*
     * 5. Extract pages.
     */
    let pages =
        extractImages(
            chapterPage.html
        );

    /*
     * Final filtering.
     */
    pages =
        pages.filter(
            looksLikeReaderImage
        );

    /*
     * Remove duplicates.
     */
    pages =
        [...new Set(pages)];

    if (!pages.length) {
        throw new Error(
            `No reader pages found for ${wantedTitle} chapter ${wantedChapter}.`
        );
    }

    /*
     * A reader should normally have multiple
     * images. A single image can still be valid,
     * so don't reject it automatically.
     */
    return {
        title:
            manga.title ||
            wantedTitle,

        chapter:
            wantedChapter,

        source:
            "MangaBats",

        pages
    };
}

module.exports = {
    name: "MangaBats",

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
