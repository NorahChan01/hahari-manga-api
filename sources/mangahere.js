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
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
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

    return (
        String(a).trim() === String(b).trim() ||
        Number(a) === Number(b)
    );
}

function extractChapterNumber(text) {
    const value = String(text || "");

    const patterns = [
        /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
        /\bc[\s._-]*(\d+(?:\.\d+)?)(?:[^\d]|$)/i,
        /\/c(\d+)(?:\/|\.html|$)/i
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
 * MangaHere uses the old DM5 reader system.
 *
 * The actual reader commonly contains variables such as:
 *
 *   page = ...
 *   pages = ...
 *   pix = ...
 *   pvalue = ...
 *
 * We deliberately DO NOT accept normal website PNG/JPG
 * assets such as logo.png, reader-win.png, etc.
 */

function isReaderImage(url) {
    if (!url) return false;

    const lower = url.toLowerCase();

    /*
     * Reject obvious MangaHere UI assets.
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
        "/images/loading",
        "/images/1.png",
        "/images/2.png",
        "/images/3.png",
        "/images/4.png"
    ];

    if (blocked.some(x => lower.includes(x))) {
        return false;
    }

    /*
     * Reader images normally come from a different image
     * path/CDN, not the site's static /images/ directory.
     */
    if (
        lower.includes("static.mangahere.cc") &&
        lower.includes("/images/")
    ) {
        return false;
    }

    return (
        /\.(jpg|jpeg|webp)(?:\?|$)/i.test(url) ||
        /\/manga\//i.test(url) ||
        /\/chapter/i.test(url) ||
        /\/comic/i.test(url)
    );
}

function extractRealImagesFromHTML(html) {
    const images = [];
    const $ = cheerio.load(html);

    /*
     * Only inspect reader-specific containers first.
     */
    const selectors = [
        "#chapter-reader img",
        ".reader-content img",
        ".reading-content img",
        ".chapter-content img",
        ".container-chapter-reader img",
        ".page-chapter img",
        ".v-img img"
    ];

    for (const selector of selectors) {
        $(selector).each((_, el) => {
            const src =
                $(el).attr("data-original") ||
                $(el).attr("data-src") ||
                $(el).attr("data-lazy-src") ||
                $(el).attr("src");

            if (!src) return;

            const url = absolute(src);

            if (url && isReaderImage(url)) {
                images.push(url);
            }
        });
    }

    /*
     * Search inline JavaScript for actual image URLs.
     */
    $("script").each((_, el) => {
        const script = $(el).html() || "";

        const urlRegex =
            /https?:\/\/[^"'\\\s]+?\.(?:jpg|jpeg|webp)(?:\?[^"'\\\s]*)?/gi;

        const matches = script.match(urlRegex);

        if (!matches) return;

        for (const match of matches) {
            const clean = match
                .replace(/\\u0026/g, "&")
                .replace(/\\\//g, "/")
                .replace(/\\x26/g, "&");

            if (isReaderImage(clean)) {
                images.push(clean);
            }
        }
    });

    return unique(images);
}

function unique(array) {
    return [...new Set(
        array
            .filter(Boolean)
            .map(x => x.trim())
    )];
}

/*
 * Extract values from JavaScript.
 */
function extractVariable(html, names) {
    for (const name of names) {
        const patterns = [
            new RegExp(
                `(?:var|let|const)\\s+${name}\\s*=\\s*["']([^"']+)["']`,
                "i"
            ),
            new RegExp(
                `${name}\\s*=\\s*["']([^"']+)["']`,
                "i"
            ),
            new RegExp(
                `"${name}"\\s*:\\s*["']([^"']+)["']`,
                "i"
            ),
            new RegExp(
                `'${name}'\\s*:\\s*["']([^"']+)["']`,
                "i"
            )
        ];

        for (const regex of patterns) {
            const match = html.match(regex);

            if (match) {
                return match[1];
            }
        }
    }

    return null;
}

/*
 * Search for arrays of image URLs.
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

            const urls = body.match(
                /["']([^"']+\.(?:jpg|jpeg|webp)(?:\?[^"']*)?)["']/gi
            );

            if (!urls) continue;

            for (const item of urls) {
                const clean = item
                    .replace(/^["']|["']$/g, "")
                    .replace(/\\\//g, "/")
                    .replace(/\\u0026/g, "&");

                const url = absolute(clean);

                if (url && isReaderImage(url)) {
                    results.push(url);
                }
            }
        }
    }

    return unique(results);
}

/*
 * Search HTML for reader image paths.
 *
 * We intentionally require manga-reader-looking paths and
 * reject the site's static UI image directory.
 */
function extractReaderPaths(html) {
    const results = [];

    const patterns = [
        /["']([^"']*\/(?:manga|chapter|comic|reader)[^"']*\.(?:jpg|jpeg|webp)(?:\?[^"']*)?)["']/gi,
        /["']([^"']*\.(?:jpg|jpeg|webp)(?:\?[^"']*)?)["']/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html)) !== null) {
            const raw = match[1]
                .replace(/\\\//g, "/")
                .replace(/\\u0026/g, "&");

            const url = absolute(raw);

            if (url && isReaderImage(url)) {
                results.push(url);
            }
        }
    }

    return unique(results);
}

async function searchManga(title) {
    const wanted = normalize(title);

    const searchUrls = [
        `${BASE_URL}/search?title=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/?title=${encodeURIComponent(title)}`
    ];

    for (const url of searchUrls) {
        try {
            const response = await client.get(url);

            const $ = cheerio.load(response.data);

            const results = [];

            $("a[href*='/manga/']").each((_, el) => {
                const href = $(el).attr("href");

                const text =
                    $(el).attr("title") ||
                    $(el).text().trim();

                if (!href || !text) return;

                const name = text
                    .replace(/\s+/g, " ")
                    .trim();

                const normalized = normalize(name);

                let score = 0;

                if (normalized === wanted) {
                    score = 100;
                } else if (normalized.includes(wanted)) {
                    score = 80;
                } else if (wanted.includes(normalized)) {
                    score = 70;
                }

                results.push({
                    title: name,
                    url: absolute(href),
                    score
                });
            });

            const uniqueResults = results.filter(
                (item, index, array) =>
                    item.url &&
                    array.findIndex(
                        x => x.url === item.url
                    ) === index
            );

            uniqueResults.sort(
                (a, b) => b.score - a.score
            );

            if (uniqueResults.length) {
                return uniqueResults[0];
            }
        } catch (_) {}
    }

    return null;
}

async function findChapter(manga, chapter) {
    const response = await client.get(manga.url, {
        headers: {
            Referer: BASE_URL + "/"
        }
    });

    const $ = cheerio.load(response.data);

    let chapterUrl = null;

    /*
     * MangaHere chapter list.
     */
    $("#chapterlist li a").each((_, el) => {
        if (chapterUrl) return;

        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href) return;

        const number =
            extractChapterNumber(`${text} ${href}`);

        if (sameChapter(number, chapter)) {
            chapterUrl = absolute(href, manga.url);
        }
    });

    /*
     * Fallback for different layouts.
     */
    if (!chapterUrl) {
        $("a[href]").each((_, el) => {
            if (chapterUrl) return;

            const href = $(el).attr("href");
            const text = $(el).text().trim();

            if (!href) return;

            const number =
                extractChapterNumber(`${text} ${href}`);

            if (sameChapter(number, chapter)) {
                chapterUrl = absolute(href, manga.url);
            }
        });
    }

    return chapterUrl;
}

async function extractPages(chapterUrl) {
    const response = await client.get(chapterUrl, {
        headers: {
            Referer: chapterUrl
        }
    });

    const html = response.data;

    /*
     * 1. Direct reader images.
     */
    let pages = extractRealImagesFromHTML(html);

    if (pages.length > 1) {
        return unique(pages);
    }

    /*
     * 2. JavaScript image arrays.
     */
    const arrayImages = extractImageArrays(html);

    if (arrayImages.length > pages.length) {
        pages = arrayImages;
    }

    if (pages.length > 1) {
        return unique(pages);
    }

    /*
     * 3. Reader paths.
     */
    const readerPaths = extractReaderPaths(html);

    if (readerPaths.length > pages.length) {
        pages = readerPaths;
    }

    if (pages.length > 1) {
        return unique(pages);
    }

    /*
     * 4. Look for reader variables.
     */
    const pix = extractVariable(
        html,
        ["pix", "imgHost", "imageHost", "imageServer"]
    );

    const pvalue = extractVariable(
        html,
        ["pvalue", "image", "chapterPath", "pagePath"]
    );

    if (pix && pvalue) {
        const host = pix.startsWith("http")
            ? pix
            : `https:${pix}`;

        const possible = [
            absolute(pvalue, host),
            absolute(
                pvalue.startsWith("/")
                    ? pvalue
                    : `/${pvalue}`,
                host
            )
        ];

        for (const url of possible) {
            if (url && isReaderImage(url)) {
                pages.push(url);
            }
        }
    }

    return unique(pages);
}

module.exports = {
    name: "MangaHere",

    async getChapter(title, chapter) {
        if (!title || chapter === undefined || chapter === null) {
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

        const chapterUrl =
            await findChapter(manga, chapter);

        if (!chapterUrl) {
            throw new Error(
                `Chapter ${chapter} was not found for "${title}" on MangaHere.`
            );
        }

        const pages =
            await extractPages(chapterUrl);

        const cleanPages = unique(
            pages.filter(isReaderImage)
        );

        /*
         * A real chapter should have more than one image.
         * This prevents false positives such as:
         *
         * logo.png
         * 1.png
         * 2.png
         */
        if (cleanPages.length < 2) {
            throw new Error(
                `MangaHere reader was found, but no real manga pages could be extracted for "${title}" chapter ${chapter}.`
            );
        }

        return {
            title: manga.title || title,
            chapter: String(chapter),
            source: "MangaHere",
            pages: cleanPages
        };
    }
};
