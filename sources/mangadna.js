const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://mangadna.com";

const client = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[’']/g, "")
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

function cleanUrl(url) {
    if (!url) return null;

    return String(url)
        .replace(/\\\//g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/&amp;/g, "&")
        .trim();
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

function sameChapter(a, b) {
    if (a == null || b == null) return false;

    const aa = String(a).trim();
    const bb = String(b).trim();

    if (aa === bb) return true;

    const na = Number(aa);
    const nb = Number(bb);

    return (
        Number.isFinite(na) &&
        Number.isFinite(nb) &&
        na === nb
    );
}

function extractChapterNumber(text) {
    const value = String(text || "");

    const patterns = [
        /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
        /chap[\s._-]*(\d+(?:\.\d+)?)/i,
        /c[\s._-]*(\d+(?:\.\d+)?)(?:[^\d]|$)/i
    ];

    for (const regex of patterns) {
        const match = value.match(regex);

        if (match) {
            return match[1];
        }
    }

    return null;
}

/*
 * MangaDNA currently uses:
 *
 * /manga/{slug}
 * /manga/{slug}/chapter-{number}
 */
function buildSlug(title) {
    return normalize(title)
        .replace(/\s+/g, "-");
}

/*
 * Strict reader-image validation.
 *
 * MangaDNA's reader images are normally numbered:
 *
 * 1.jpg
 * 2.jpg
 * 3.jpg
 *
 * The important part is that we DON'T accept cover images,
 * logos, thumbnails or random website assets.
 */
function isReaderImage(url) {
    if (!url) return false;

    const clean = cleanUrl(url);

    if (!/^https?:\/\//i.test(clean)) {
        return false;
    }

    const lower = clean.toLowerCase();

    /*
     * Never accept covers.
     */
    if (
        lower.includes("/cover.") ||
        lower.includes("/covers/") ||
        lower.includes("cover_thumb") ||
        lower.includes("thumbnail") ||
        lower.includes("thumb.")
    ) {
        return false;
    }

    /*
     * Reject obvious site assets.
     */
    const blocked = [
        "/logo.",
        "/logos/",
        "/favicon",
        "/icon.",
        "/icons/",
        "/avatar",
        "/banner",
        "/ads/",
        "/advert",
        "/loading.",
        "/spinner.",
        "/social/"
    ];

    if (blocked.some(x => lower.includes(x))) {
        return false;
    }

    /*
     * MangaDNA reader images are JPG/JPEG.
     */
    if (!/\.(jpg|jpeg)(?:[?#]|$)/i.test(lower)) {
        return false;
    }

    const pathname = new URL(clean).pathname;
    const filename =
        pathname.split("/").pop() || "";

    /*
     * Strong numbered-image check.
     *
     * Supports:
     *
     * 1.jpg
     * 01.jpg
     * 001.jpg
     * 1-2.jpg
     * 01_result01.jpg
     * etc.
     */
    const numberedPatterns = [
        /^\d+\.jpe?g$/i,
        /^\d+-\d+\.jpe?g$/i,
        /^\d+_[a-z0-9_-]+\.jpe?g$/i,
        /^\d+-[a-z0-9_-]+\.jpe?g$/i,
        /^\d+_[a-z0-9_-]+_result\d*\.jpe?g$/i,
        /^\d+-[a-z0-9_-]+_result\d*\.jpe?g$/i
    ];

    if (numberedPatterns.some(regex => regex.test(filename))) {
        return true;
    }

    /*
     * Some reader CDNs use a numeric filename with
     * additional query parameters.
     */
    const filenameWithoutQuery =
        filename.split("?")[0].split("#")[0];

    if (/^\d+\.jpe?g$/i.test(filenameWithoutQuery)) {
        return true;
    }

    return false;
}

/*
 * Extract all potential reader images from HTML.
 */
function extractImagesFromHTML(html) {
    const results = [];
    const $ = cheerio.load(html);

    const selectors = [
        "#readerarea img",
        "#chapter-reader img",
        ".reading-content img",
        ".reader-content img",
        ".chapter-content img",
        ".page-break img",
        ".read-content img",
        ".reader img",
        "img"
    ];

    for (const selector of selectors) {
        $(selector).each((_, el) => {
            const candidates = [
                $(el).attr("data-src"),
                $(el).attr("data-original"),
                $(el).attr("data-lazy-src"),
                $(el).attr("data-url"),
                $(el).attr("src")
            ];

            for (const raw of candidates) {
                if (!raw) continue;

                const url = absolute(cleanUrl(raw));

                if (url && isReaderImage(url)) {
                    results.push(url);
                    break;
                }
            }
        });
    }

    return unique(results);
}

/*
 * Extract reader images from inline JavaScript.
 */
function extractImagesFromScripts(html) {
    const results = [];
    const $ = cheerio.load(html);

    $("script").each((_, el) => {
        const script = $(el).html() || "";

        /*
         * Direct URLs.
         */
        const directRegex =
            /https?:\/\/[^"'\\\s]+?\.(?:jpg|jpeg)(?:\?[^"'\\\s]*)?/gi;

        const directMatches =
            script.match(directRegex) || [];

        for (const raw of directMatches) {
            const url = cleanUrl(raw);

            if (isReaderImage(url)) {
                results.push(url);
            }
        }

        /*
         * Relative URLs.
         */
        const relativeRegex =
            /["']([^"']+\.(?:jpg|jpeg)(?:\?[^"']*)?)["']/gi;

        let match;

        while ((match = relativeRegex.exec(script)) !== null) {
            const url = absolute(
                cleanUrl(match[1])
            );

            if (url && isReaderImage(url)) {
                results.push(url);
            }
        }
    });

    return unique(results);
}

/*
 * Extract arrays such as:
 *
 * images = [...]
 * pages = [...]
 * chapterImages = [...]
 */
function extractImageArrays(html) {
    const results = [];

    const patterns = [
        /(?:images|pages|chapterImages|pageImages|imageList)\s*=\s*\[([\s\S]*?)\]/gi,
        /(?:images|pages|chapterImages|pageImages|imageList)\s*:\s*\[([\s\S]*?)\]/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html)) !== null) {
            const body = match[1];

            const imageRegex =
                /["']([^"']+\.(?:jpg|jpeg)(?:\?[^"']*)?)["']/gi;

            let imageMatch;

            while (
                (imageMatch = imageRegex.exec(body)) !== null
            ) {
                const url = absolute(
                    cleanUrl(imageMatch[1])
                );

                if (url && isReaderImage(url)) {
                    results.push(url);
                }
            }
        }
    }

    return unique(results);
}

/*
 * Extract numbered image filenames from any text.
 */
function extractNumberedImageUrls(html) {
    const results = [];

    const regex =
        /(?:https?:)?\/\/[^"'\\\s<>]+\/\d+\.jpe?g(?:\?[^"'\\\s<>]*)?/gi;

    const matches =
        html.match(regex) || [];

    for (const raw of matches) {
        let url = cleanUrl(raw);

        if (url.startsWith("//")) {
            url = "https:" + url;
        }

        if (isReaderImage(url)) {
            results.push(url);
        }
    }

    return unique(results);
}

/*
 * MangaDNA search.
 *
 * We first try the site's search form/endpoints.
 * If that doesn't work, we try the direct slug.
 */
async function searchManga(title) {
    const wanted = normalize(title);

    const candidates = [];

    /*
     * Direct slug is extremely useful for MangaDNA.
     */
    const slug = buildSlug(title);

    candidates.push(
        `${BASE_URL}/manga/${slug}`
    );

    /*
     * Search page variants.
     */
    candidates.push(
        `${BASE_URL}/search?keyword=${encodeURIComponent(title)}`
    );

    candidates.push(
        `${BASE_URL}/search?q=${encodeURIComponent(title)}`
    );

    candidates.push(
        `${BASE_URL}/search/${encodeURIComponent(title)}`
    );

    let best = null;

    for (const url of candidates) {
        try {
            const response = await client.get(url, {
                headers: {
                    Referer: BASE_URL + "/"
                }
            });

            const $ = cheerio.load(response.data);

            /*
             * If this is already the exact manga page,
             * verify its H1.
             */
            const h1 = $("h1").first().text().trim();

            if (
                h1 &&
                normalize(h1) === wanted
            ) {
                return {
                    title: h1,
                    url: response.request?.res?.responseUrl ||
                         url
                };
            }

            /*
             * Search links.
             */
            $("a[href*='/manga/']").each((_, el) => {
                const href = $(el).attr("href");

                if (!href) return;

                const fullUrl =
                    absolute(href);

                if (!fullUrl) return;

                /*
                 * Ignore chapter links.
                 */
                if (
                    /\/chapter-/i.test(
                        new URL(fullUrl).pathname
                    )
                ) {
                    return;
                }

                const text =
                    $(el).attr("title") ||
                    $(el).find("img").attr("alt") ||
                    $(el).text().trim();

                const name =
                    String(text || "")
                        .replace(/\s+/g, " ")
                        .trim();

                if (!name) return;

                const normalized =
                    normalize(name);

                let score = 0;

                if (normalized === wanted) {
                    score = 100;
                } else if (
                    normalized.includes(wanted)
                ) {
                    score = 80;
                } else if (
                    wanted.includes(normalized)
                ) {
                    score = 70;
                }

                if (score === 0) return;

                candidates.push({
                    title: name,
                    url: fullUrl,
                    score
                });
            });

            /*
             * Process collected result objects.
             */
            for (const item of candidates) {
                if (!item || !item.url) continue;
                if (typeof item !== "object") continue;

                if (
                    !best ||
                    (item.score || 0) >
                    (best.score || 0)
                ) {
                    best = item;
                }
            }

            if (best && best.score >= 100) {
                return best;
            }

        } catch (error) {
            console.log(
                `[MangaDNA] Search failed: ${url} - ${error.message}`
            );
        }
    }

    /*
     * Final direct-slug fallback.
     */
    try {
        const directUrl =
            `${BASE_URL}/manga/${slug}`;

        const response =
            await client.get(directUrl);

        const $ =
            cheerio.load(response.data);

        const titleText =
            $("h1").first().text().trim();

        if (
            titleText &&
            normalize(titleText) === wanted
        ) {
            return {
                title: titleText,
                url: directUrl,
                score: 100
            };
        }
    } catch (_) {}

    return best;
}

/*
 * Find chapter from the manga page.
 */
async function findChapter(manga, chapter) {
    /*
     * First try direct MangaDNA URL.
     */
    const slugMatch =
        String(manga.url)
            .match(/\/manga\/([^/?#]+)/i);

    if (slugMatch) {
        const slug = slugMatch[1];

        const directUrl =
            `${BASE_URL}/manga/${slug}/chapter-${chapter}`;

        try {
            const response =
                await client.get(directUrl, {
                    headers: {
                        Referer: manga.url
                    }
                });

            /*
             * A real MangaDNA chapter page has
             * "One Piece - Chapter 1191" style title.
             */
            const $ =
                cheerio.load(response.data);

            const h1 =
                $("h1").first().text().trim();

            const detected =
                extractChapterNumber(
                    `${h1} ${directUrl}`
                );

            if (
                sameChapter(
                    detected,
                    chapter
                )
            ) {
                return directUrl;
            }

            /*
             * Even if H1 is absent, verify that
             * the page contains the chapter number.
             */
            if (
                response.data &&
                new RegExp(
                    `chapter\\s*${String(chapter)
                        .replace(".", "\\.")}`,
                    "i"
                ).test(response.data)
            ) {
                return directUrl;
            }

        } catch (error) {
            console.log(
                `[MangaDNA] Direct chapter failed: ${error.message}`
            );
        }
    }

    /*
     * Fallback: inspect manga page chapter links.
     */
    try {
        const response =
            await client.get(manga.url, {
                headers: {
                    Referer: BASE_URL + "/"
                }
            });

        const $ =
            cheerio.load(response.data);

        let result = null;

        $("a[href]").each((_, el) => {
            if (result) return;

            const href =
                $(el).attr("href");

            if (!href) return;

            const full =
                absolute(href, manga.url);

            if (!full) return;

            const text =
                $(el).text().trim();

            const detected =
                extractChapterNumber(
                    `${text} ${href} ${full}`
                );

            if (
                sameChapter(
                    detected,
                    chapter
                )
            ) {
                result = full;
            }
        });

        return result;

    } catch (error) {
        throw new Error(
            `Could not inspect MangaDNA chapter list: ${error.message}`
        );
    }
}

/*
 * Extract pages from the actual chapter page.
 */
async function extractPages(chapterUrl) {
    const response =
        await client.get(chapterUrl, {
            headers: {
                Referer: chapterUrl,
                "Accept":
                    "text/html,application/xhtml+xml"
            }
        });

    const html = response.data;

    let pages = [];

    /*
     * Method 1:
     * Reader <img> elements.
     */
    pages.push(
        ...extractImagesFromHTML(html)
    );

    /*
     * Method 2:
     * JavaScript.
     */
    pages.push(
        ...extractImagesFromScripts(html)
    );

    /*
     * Method 3:
     * Image arrays.
     */
    pages.push(
        ...extractImageArrays(html)
    );

    /*
     * Method 4:
     * Numbered direct URLs.
     */
    pages.push(
        ...extractNumberedImageUrls(html)
    );

    pages = unique(
        pages.filter(isReaderImage)
    );

    /*
     * Sort numbered pages naturally.
     */
    pages.sort((a, b) => {
        function number(url) {
            try {
                const filename =
                    new URL(url)
                        .pathname
                        .split("/")
                        .pop();

                const match =
                    filename.match(/^(\d+)/);

                return match
                    ? Number(match[1])
                    : Number.MAX_SAFE_INTEGER;
            } catch {
                return Number.MAX_SAFE_INTEGER;
            }
        }

        return number(a) - number(b);
    });

    return pages;
}

module.exports = {
    name: "MangaDNA",

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

        console.log(
            `[MangaDNA] Searching: "${title}" chapter ${chapter}`
        );

        const manga =
            await searchManga(title);

        if (!manga) {
            throw new Error(
                `Manga "${title}" was not found on MangaDNA.`
            );
        }

        console.log(
            `[MangaDNA] Manga: ${manga.title || title}`
        );

        console.log(
            `[MangaDNA] URL: ${manga.url}`
        );

        const chapterUrl =
            await findChapter(
                manga,
                chapter
            );

        if (!chapterUrl) {
            throw new Error(
                `Chapter ${chapter} was not found for "${title}" on MangaDNA.`
            );
        }

        console.log(
            `[MangaDNA] Chapter URL: ${chapterUrl}`
        );

        const pages =
            await extractPages(chapterUrl);

        const cleanPages =
            unique(
                pages.filter(isReaderImage)
            );

        if (cleanPages.length < 2) {
            throw new Error(
                `MangaDNA found chapter ${chapter}, but could not extract real reader pages.`
            );
        }

        console.log(
            `[MangaDNA] Found ${cleanPages.length} reader pages.`
        );

        return {
            title: manga.title || title,
            chapter: String(chapter),
            source: "MangaDNA",
            pages: cleanPages
        };
    }
};
