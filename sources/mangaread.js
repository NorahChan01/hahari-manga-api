const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.mangaread.org";

const http = axios.create({
    timeout: 30000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function slugify(text) {
    return normalize(text).replace(/\s+/g, "-");
}

function absolute(url) {
    if (!url) return null;

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

function extractChapterNumber(text) {
    const value = String(text || "");

    let match = value.match(
        /chapter[\s\-]*(\d+(?:\.\d+)?)/i
    );

    if (match) return match[1];

    match = value.match(
        /\/chapter[\-\/](\d+(?:\.\d+)?)/i
    );

    if (match) return match[1];

    return null;
}

function chapterMatches(found, wanted) {
    const a = String(found || "").trim();
    const b = String(wanted || "").trim();

    if (a === b) return true;

    const na = Number(a);
    const nb = Number(b);

    return Number.isFinite(na) &&
        Number.isFinite(nb) &&
        na === nb;
}

/*
 * MangaRead's manga pages use:
 *
 * https://www.mangaread.org/manga/one-piece/
 *
 * We first try the site's search, then use the direct slug.
 */
async function findManga(title) {
    const wanted = normalize(title);

    /*
     * 1. Try site search.
     */
    try {
        const searchUrl =
            `${BASE_URL}/?s=${encodeURIComponent(title)}`;

        const response = await http.get(searchUrl);

        const $ = cheerio.load(response.data);

        const results = [];

        $("a[href]").each((_, element) => {
            const href = $(element).attr("href");
            const text = $(element).text().trim();

            if (!href) return;

            const url = absolute(href);

            if (!url) return;

            if (!url.includes("/manga/")) return;

            if (url.includes("/chapter-")) return;

            const cleanTitle = normalize(text);

            if (!cleanTitle) return;

            let score = 0;

            if (cleanTitle === wanted) {
                score = 1000;
            } else if (cleanTitle.includes(wanted)) {
                score = 800;
            } else if (wanted.includes(cleanTitle)) {
                score = 700;
            } else {
                const wantedWords = wanted.split(" ");
                const foundWords = cleanTitle.split(" ");

                const common = wantedWords.filter(
                    word => foundWords.includes(word)
                ).length;

                score = common * 50;
            }

            if (score > 0) {
                const exists = results.find(
                    item => item.url === url
                );

                if (!exists) {
                    results.push({
                        title: text,
                        url,
                        score
                    });
                }
            }
        });

        if (results.length) {
            results.sort((a, b) => b.score - a.score);

            return results[0];
        }
    } catch (_) {}

    /*
     * 2. Direct slug lookup.
     *
     * This is important because MangaRead has a very
     * predictable /manga/{slug}/ structure.
     */
    const slug = slugify(title);

    const candidates = [
        `${BASE_URL}/manga/${slug}/`,
        `${BASE_URL}/manga/${slug}`
    ];

    for (const url of candidates) {
        try {
            const response = await http.get(url);

            if (response.status !== 200) continue;

            const $ = cheerio.load(response.data);

            /*
             * Don't require wp-manga classes.
             * The actual MangaRead page has the manga title
             * and chapter links directly in the HTML.
             */
            const pageTitle =
                $("h1").first().text().trim() ||
                $("title").first().text().trim();

            if (!pageTitle) continue;

            const normalizedPageTitle =
                normalize(pageTitle);

            /*
             * Make sure this is actually the requested manga.
             */
            if (
                normalizedPageTitle === wanted ||
                normalizedPageTitle.includes(wanted) ||
                wanted.includes(normalizedPageTitle)
            ) {
                return {
                    title: pageTitle,
                    url
                };
            }

            /*
             * If the page contains chapter links and the
             * expected slug, accept it as well.
             */
            if (
                response.data.includes(`/manga/${slug}`)
            ) {
                return {
                    title: pageTitle || title,
                    url
                };
            }
        } catch (_) {}
    }

    return null;
}

/*
 * Find the exact chapter from the manga page.
 */
async function findChapter(mangaUrl, chapter) {
    const response = await http.get(mangaUrl, {
        headers: {
            Referer: BASE_URL + "/"
        }
    });

    const $ = cheerio.load(response.data);

    const wanted = String(chapter).trim();

    const candidates = [];

    $("a[href]").each((_, element) => {
        const href = $(element).attr("href");
        const text = $(element).text().trim();

        if (!href) return;

        const url = absolute(href);

        if (!url) return;

        /*
         * MangaRead chapter URLs contain /chapter-
         */
        if (!url.toLowerCase().includes("/chapter-")) {
            return;
        }

        const number =
            extractChapterNumber(text) ||
            extractChapterNumber(url);

        if (!number) return;

        if (chapterMatches(number, wanted)) {
            candidates.push({
                url,
                text,
                number
            });
        }
    });

    if (!candidates.length) {
        return null;
    }

    /*
     * Prefer the first exact chapter result.
     */
    return candidates[0].url;
}

/*
 * Extract actual reader pages.
 */
function extractPages(html) {
    const $ = cheerio.load(html);

    const pages = [];

    /*
     * MangaRead's actual reader uses images on the
     * chapter page. reading-content is preferred.
     */
    const selectors = [
        "div.reading-content img",
        ".reading-content img",
        ".chapter-content img",
        ".entry-content img",
        "img"
    ];

    for (const selector of selectors) {
        $(selector).each((_, element) => {
            const attributes = [
                "src",
                "data-src",
                "data-lazy-src",
                "data-original"
            ];

            for (const attribute of attributes) {
                const value =
                    $(element).attr(attribute);

                if (!value) continue;

                const url = absolute(value);

                if (!url) continue;

                const lower = url.toLowerCase();

                /*
                 * Remove obvious website UI images.
                 */
                if (
                    lower.includes("logo") ||
                    lower.includes("avatar") ||
                    lower.includes("icon") ||
                    lower.includes("loading") ||
                    lower.includes("spinner") ||
                    lower.includes("reader-win") ||
                    lower.includes("favicon")
                ) {
                    continue;
                }

                /*
                 * Only accept real image URLs.
                 */
                if (
                    /\.(jpg|jpeg|png|webp|avif)(\?.*)?$/i
                        .test(url)
                ) {
                    if (!pages.includes(url)) {
                        pages.push(url);
                    }

                    break;
                }
            }
        });

        /*
         * If this selector produced real pages,
         * don't fall through to generic img.
         */
        if (pages.length > 0) {
            break;
        }
    }

    return pages;
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (
        chapter === undefined ||
        chapter === null ||
        String(chapter).trim() === ""
    ) {
        throw new Error("Chapter number is required.");
    }

    /*
     * STEP 1:
     * Find manga.
     */
    const manga = await findManga(title);

    if (!manga) {
        throw new Error(
            `Manga "${title}" was not found on MangaRead.`
        );
    }

    /*
     * STEP 2:
     * Find exact chapter.
     */
    const chapterUrl = await findChapter(
        manga.url,
        chapter
    );

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${chapter} was not found for "${title}" on MangaRead.`
        );
    }

    /*
     * STEP 3:
     * Open chapter reader.
     */
    const chapterResponse = await http.get(
        chapterUrl,
        {
            headers: {
                Referer: manga.url
            }
        }
    );

    /*
     * STEP 4:
     * Extract pages.
     */
    const pages = extractPages(
        chapterResponse.data
    );

    if (!pages.length) {
        throw new Error(
            `MangaRead found chapter ${chapter}, but no real manga page images were extracted.`
        );
    }

    return {
        success: true,
        title: manga.title || title,
        chapter: String(chapter),
        source: "MangaRead",
        pages
    };
}

module.exports = {
    name: "MangaRead",
    getChapter
};
