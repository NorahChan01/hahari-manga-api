const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.mangahere.cc";

const client = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function absolute(url, base = BASE_URL) {
    try {
        return new URL(url, base).href;
    } catch {
        return null;
    }
}

function sameChapter(a, b) {
    if (a == null) return false;

    const aa = String(a).trim();
    const bb = String(b).trim();

    if (aa === bb) return true;

    const na = Number(aa);
    const nb = Number(bb);

    return Number.isFinite(na) &&
           Number.isFinite(nb) &&
           na === nb;
}

function extractChapterNumber(text) {
    const value = String(text || "");

    const patterns = [
        /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
        /\bc[\s._-]*(\d+(?:\.\d+)?)(?:[^\d]|$)/i,
        /\/c(\d+(?:\.\d+)?)(?:\/|\.html|$)/i
    ];

    for (const regex of patterns) {
        const match = value.match(regex);

        if (match) {
            return match[1];
        }
    }

    return null;
}

function cleanUrl(url) {
    if (!url) return null;

    return String(url)
        .replace(/\\u0026/g, "&")
        .replace(/\\x26/g, "&")
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .trim();
}

/*
 * VERY STRICT image validation.
 *
 * MangaHere search/list pages contain many cover images.
 * We never accept:
 *
 *   /cover.jpg
 *   /covers/...
 *   /store/manga/.../cover.jpg
 *
 * as chapter pages.
 */
function isRealChapterImage(url) {
    if (!url) return false;

    const lower = cleanUrl(url).toLowerCase();

    if (!/^https?:\/\//i.test(lower)) {
        return false;
    }

    /*
     * Hard reject covers.
     */
    if (
        lower.includes("/cover.") ||
        lower.includes("/covers/") ||
        lower.includes("cover.jpg") ||
        lower.includes("cover.jpeg") ||
        lower.includes("cover.webp")
    ) {
        return false;
    }

    /*
     * Reject MangaHere website UI assets.
     */
    const blocked = [
        "/images/logo",
        "/images/detail-",
        "/images/downlist",
        "/images/top-bar",
        "/images/emotion",
        "/images/win-cross",
        "/images/cross",
        "/images/reader-win",
        "/images/header",
        "/images/footer",
        "/images/avatar",
        "/images/icon",
        "/images/button",
        "/images/loading"
    ];

    if (blocked.some(x => lower.includes(x))) {
        return false;
    }

    /*
     * Static site assets are not reader pages.
     */
    if (
        lower.includes("mangahere.cc/images/") ||
        lower.includes("static.mangahere.cc/images/")
    ) {
        return false;
    }

    /*
     * Reader images generally contain manga/store paths.
     *
     * Accept CDN images only when they are NOT covers.
     */
    const imageExtension =
        /\.(jpg|jpeg|png|webp)(?:[?#]|$)/i.test(lower);

    if (!imageExtension) {
        return false;
    }

    /*
     * Strong reader indicators.
     */
    if (
        /\/store\/manga\/\d+\//i.test(lower) ||
        /\/manga\/[^/]+\/v[^/]+\/c\d+/i.test(lower) ||
        /\/manga\/[^/]+\/c\d+/i.test(lower) ||
        /\/chapter\/\d+/i.test(lower) ||
        /\/reader\//i.test(lower)
    ) {
        return true;
    }

    return false;
}

function unique(array) {
    return [
        ...new Set(
            array
                .filter(Boolean)
                .map(cleanUrl)
                .filter(Boolean)
        )
    ];
}

/*
 * Extract image URLs from reader HTML.
 */
function extractImagesFromHTML(html) {
    const results = [];
    const $ = cheerio.load(html);

    const selectors = [
        "#chapter-reader img",
        ".reader-content img",
        ".reading-content img",
        ".chapter-content img",
        ".container-chapter-reader img",
        ".page-chapter img",
        ".v-img img",
        "#manga-page img",
        ".read-img img"
    ];

    for (const selector of selectors) {
        $(selector).each((_, el) => {
            const candidates = [
                $(el).attr("data-original"),
                $(el).attr("data-src"),
                $(el).attr("data-lazy-src"),
                $(el).attr("data-url"),
                $(el).attr("src")
            ];

            for (const raw of candidates) {
                if (!raw) continue;

                const url = absolute(cleanUrl(raw));

                if (url && isRealChapterImage(url)) {
                    results.push(url);
                    break;
                }
            }
        });
    }

    /*
     * Search all image tags as fallback.
     */
    if (results.length < 2) {
        $("img").each((_, el) => {
            const candidates = [
                $(el).attr("data-original"),
                $(el).attr("data-src"),
                $(el).attr("data-lazy-src"),
                $(el).attr("src")
            ];

            for (const raw of candidates) {
                if (!raw) continue;

                const url = absolute(cleanUrl(raw));

                if (url && isRealChapterImage(url)) {
                    results.push(url);
                    break;
                }
            }
        });
    }

    return unique(results);
}

/*
 * Extract literal image URLs from scripts.
 */
function extractScriptImages(html) {
    const results = [];
    const $ = cheerio.load(html);

    $("script").each((_, el) => {
        const script = $(el).html() || "";

        const regex =
            /https?:\/\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\\s]*)?/gi;

        const matches = script.match(regex);

        if (!matches) return;

        for (const raw of matches) {
            const url = cleanUrl(raw);

            if (isRealChapterImage(url)) {
                results.push(url);
            }
        }
    });

    return unique(results);
}

/*
 * Search arrays such as:
 *
 * pages = [...]
 * images = [...]
 * chapterImages = [...]
 */
function extractImageArrays(html) {
    const results = [];

    const patterns = [
        /(?:pages|pageImages|chapterImages|images|imageList)\s*=\s*\[([\s\S]*?)\]/gi,
        /(?:pages|pageImages|chapterImages|images|imageList)\s*:\s*\[([\s\S]*?)\]/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html)) !== null) {
            const body = match[1];

            const urlRegex =
                /["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/gi;

            let urlMatch;

            while ((urlMatch = urlRegex.exec(body)) !== null) {
                const url = absolute(cleanUrl(urlMatch[1]));

                if (url && isRealChapterImage(url)) {
                    results.push(url);
                }
            }
        }
    }

    return unique(results);
}

async function searchManga(title) {
    const wanted = normalize(title);

    /*
     * MangaHere search endpoints.
     */
    const searchUrls = [
        `${BASE_URL}/search?title=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/?title=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/${encodeURIComponent(title)}`
    ];

    let best = null;

    for (const url of searchUrls) {
        try {
            const response = await client.get(url, {
                headers: {
                    Referer: BASE_URL + "/"
                }
            });

            const $ = cheerio.load(response.data);
            const results = [];

            $("a[href*='/manga/']").each((_, el) => {
                const href = $(el).attr("href");

                if (!href) return;

                const fullUrl = absolute(href);

                if (!fullUrl) return;

                /*
                 * Get title carefully.
                 */
                const text =
                    $(el).attr("title") ||
                    $(el).find("img").attr("alt") ||
                    $(el).text();

                const name = String(text || "")
                    .replace(/\s+/g, " ")
                    .trim();

                if (!name) return;

                const normalized = normalize(name);

                let score = 0;

                if (normalized === wanted) {
                    score = 100;
                } else if (normalized.includes(wanted)) {
                    score = 85;
                } else if (wanted.includes(normalized)) {
                    score = 75;
                }

                /*
                 * One Piece special protection.
                 */
                if (
                    wanted === "one piece" &&
                    normalized === "one piece"
                ) {
                    score = 110;
                }

                results.push({
                    title: name,
                    url: fullUrl,
                    score
                });
            });

            const uniqueResults = results.filter(
                (item, index, array) =>
                    array.findIndex(
                        x => x.url === item.url
                    ) === index
            );

            uniqueResults.sort(
                (a, b) => b.score - a.score
            );

            if (uniqueResults.length) {
                if (!best || uniqueResults[0].score > best.score) {
                    best = uniqueResults[0];
                }

                if (uniqueResults[0].score >= 100) {
                    return uniqueResults[0];
                }
            }
        } catch (_) {}
    }

    return best;
}

/*
 * Find the exact chapter.
 */
async function findChapter(manga, chapter) {
    const response = await client.get(manga.url, {
        headers: {
            Referer: BASE_URL + "/"
        }
    });

    const $ = cheerio.load(response.data);

    let chapterUrl = null;

    /*
     * First: MangaHere's normal chapter list.
     */
    const chapterSelectors = [
        "#chapterlist li a",
        "#chapterlist a",
        ".detail-main-list a",
        ".chapter-list a",
        "a[href*='/c']"
    ];

    for (const selector of chapterSelectors) {
        $(selector).each((_, el) => {
            if (chapterUrl) return;

            const href = $(el).attr("href");
            const text = $(el).text().trim();

            if (!href) return;

            const full = absolute(href, manga.url);

            const number =
                extractChapterNumber(
                    `${text} ${href} ${full || ""}`
                );

            if (sameChapter(number, chapter)) {
                /*
                 * Make sure this is actually a chapter URL.
                 */
                if (
                    /\/c\d+(?:\/|\.html)/i.test(full || "") ||
                    /chapter/i.test(full || "")
                ) {
                    chapterUrl = full;
                }
            }
        });

        if (chapterUrl) break;
    }

    /*
     * Fallback: inspect every link, but ONLY accept
     * links that actually look like chapter URLs.
     */
    if (!chapterUrl) {
        $("a[href]").each((_, el) => {
            if (chapterUrl) return;

            const href = $(el).attr("href");
            const text = $(el).text().trim();

            if (!href) return;

            const full = absolute(href, manga.url);

            if (!full) return;

            const looksLikeChapter =
                /\/c\d+(?:\/|\.html)/i.test(full) ||
                /\/chapter[\s._/-]*\d+/i.test(full);

            if (!looksLikeChapter) return;

            const number =
                extractChapterNumber(
                    `${text} ${href} ${full}`
                );

            if (sameChapter(number, chapter)) {
                chapterUrl = full;
            }
        });
    }

    return chapterUrl;
}

/*
 * Extract the actual reader pages.
 */
async function extractPages(chapterUrl) {
    /*
     * Important:
     * MangaHere reader pages are often one-page-per-URL.
     *
     * Start with the actual chapter page.
     */
    const response = await client.get(chapterUrl, {
        headers: {
            Referer: chapterUrl,
            Accept: "text/html,application/xhtml+xml"
        }
    });

    const html = response.data;

    let pages = [];

    /*
     * 1. Reader DOM.
     */
    pages.push(
        ...extractImagesFromHTML(html)
    );

    /*
     * 2. JavaScript arrays.
     */
    pages.push(
        ...extractImageArrays(html)
    );

    /*
     * 3. Script URLs.
     */
    pages.push(
        ...extractScriptImages(html)
    );

    pages = unique(
        pages.filter(isRealChapterImage)
    );

    /*
     * If we already have several actual images,
     * use them.
     */
    if (pages.length >= 2) {
        return pages;
    }

    /*
     * MangaHere commonly exposes reader navigation.
     *
     * Find "next page" links and walk through the reader.
     */
    const visited = new Set();
    const queue = [chapterUrl];

    while (queue.length && visited.size < 200) {
        const current = queue.shift();

        if (!current || visited.has(current)) {
            continue;
        }

        visited.add(current);

        let pageResponse;

        try {
            pageResponse = await client.get(current, {
                headers: {
                    Referer: chapterUrl
                }
            });
        } catch {
            continue;
        }

        const pageHtml = pageResponse.data;
        const $ = cheerio.load(pageHtml);

        pages.push(
            ...extractImagesFromHTML(pageHtml)
        );

        pages.push(
            ...extractImageArrays(pageHtml)
        );

        pages.push(
            ...extractScriptImages(pageHtml)
        );

        /*
         * Find reader navigation links.
         */
        $("a[href]").each((_, el) => {
            const href = $(el).attr("href");

            if (!href) return;

            const full = absolute(href, current);

            if (!full) return;

            /*
             * Only follow links belonging to the same
             * manga/chapter reader.
             */
            const currentPath = new URL(current).pathname;
            const nextPath = new URL(full).pathname;

            const sameManga =
                nextPath.includes("/manga/") &&
                currentPath.split("/manga/")[1]?.split("/")[0] ===
                nextPath.split("/manga/")[1]?.split("/")[0];

            const readerLike =
                /\/c\d+\//i.test(nextPath) ||
                /\/chapter/i.test(nextPath);

            if (sameManga && readerLike) {
                if (!visited.has(full)) {
                    queue.push(full);
                }
            }
        });

        pages = unique(
            pages.filter(isRealChapterImage)
        );
    }

    return unique(
        pages.filter(isRealChapterImage)
    );
}

module.exports = {
    name: "MangaHere",

    async getChapter(title, chapter) {
        if (
            !title ||
            chapter === undefined ||
            chapter === null
        ) {
            throw new Error(
                "Title and chapter are required."
            );
        }

        const manga = await searchManga(title);

        if (!manga) {
            throw new Error(
                `Manga "${title}" was not found on MangaHere.`
            );
        }

        console.log(
            `[MangaHere] Manga: ${manga.title}`
        );

        console.log(
            `[MangaHere] URL: ${manga.url}`
        );

        const chapterUrl =
            await findChapter(manga, chapter);

        if (!chapterUrl) {
            throw new Error(
                `Chapter ${chapter} was not found for "${title}" on MangaHere.`
            );
        }

        console.log(
            `[MangaHere] Chapter URL: ${chapterUrl}`
        );

        const pages =
            await extractPages(chapterUrl);

        const cleanPages = unique(
            pages.filter(isRealChapterImage)
        );

        /*
         * Critical protection:
         *
         * Never allow MangaHere to return only
         * covers or generic website images.
         */
        if (cleanPages.length < 2) {
            throw new Error(
                `MangaHere found chapter ${chapter}, but could not extract real reader pages.`
            );
        }

        console.log(
            `[MangaHere] Found ${cleanPages.length} real pages.`
        );

        return {
            title: manga.title || title,
            chapter: String(chapter),
            source: "MangaHere",
            pages: cleanPages
        };
    }
};
