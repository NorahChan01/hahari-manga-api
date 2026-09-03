const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://rawkuma.net";

const client = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function absoluteUrl(url, base = BASE_URL) {
    if (!url) return null;

    try {
        return new URL(url, base).href;
    } catch {
        return null;
    }
}

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

function chapterNumber(text) {
    const value = String(text || "");

    let match = value.match(
        /chapter[\s\-]*(\d+(?:\.\d+)?)/i
    );

    if (match) return match[1];

    match = value.match(
        /(?:^|[-_\/])(\d+(?:\.\d+)?)(?:[-_\/]|$)/i
    );

    return match ? match[1] : null;
}

function sameChapter(a, b) {
    const x = Number(String(a).trim());
    const y = Number(String(b).trim());

    return Number.isFinite(x) &&
        Number.isFinite(y) &&
        x === y;
}

/*
 * Find manga page.
 *
 * Rawkuma has a predictable /manga/{slug}/ structure.
 */
async function findManga(title) {
    const slug = slugify(title);

    const candidates = [
        `${BASE_URL}/manga/${slug}/`,
        `${BASE_URL}/manga/${slug}`
    ];

    for (const url of candidates) {
        try {
            const response = await client.get(url);

            if (response.status !== 200) continue;

            const $ = cheerio.load(response.data);

            const pageTitle =
                $("article h1[itemprop]").first().text().trim() ||
                $("h1[itemprop]").first().text().trim() ||
                $("h1").first().text().trim();

            if (!pageTitle) continue;

            const wanted = normalize(title);
            const found = normalize(pageTitle);

            /*
             * Accept exact or very close title matches.
             */
            if (
                found === wanted ||
                found.includes(wanted) ||
                wanted.includes(found)
            ) {
                /*
                 * Rawkuma exposes manga_id in the hx-get
                 * attribute used to load the chapter list.
                 */
                let mangaId = null;

                $("[hx-get]").each((_, element) => {
                    if (mangaId) return;

                    const hxGet =
                        $(element).attr("hx-get");

                    if (!hxGet) return;

                    const match =
                        hxGet.match(
                            /[?&]manga_id=([^&]+)/i
                        );

                    if (match) {
                        mangaId = decodeURIComponent(
                            match[1]
                        );
                    }
                });

                /*
                 * Additional fallback:
                 * look anywhere in the HTML for manga_id.
                 */
                if (!mangaId) {
                    const match =
                        response.data.match(
                            /manga_id[="'\s:]+([0-9]+)/i
                        );

                    if (match) {
                        mangaId = match[1];
                    }
                }

                return {
                    title: pageTitle,
                    url,
                    mangaId
                };
            }
        } catch (_) {}
    }

    return null;
}

/*
 * Rawkuma loads chapters through:
 *
 * /wp-admin/admin-ajax.php
 * ?manga_id=XXXX
 * &action=chapter_list
 */
async function getChapterList(manga) {
    if (!manga.mangaId) {
        throw new Error(
            "Rawkuma manga ID could not be detected."
        );
    }

    const url =
        `${BASE_URL}/wp-admin/admin-ajax.php` +
        `?manga_id=${encodeURIComponent(manga.mangaId)}` +
        `&action=chapter_list`;

    const response = await client.get(url, {
        headers: {
            Referer: manga.url,
            "X-Requested-With": "XMLHttpRequest"
        }
    });

    const $ = cheerio.load(response.data);

    const chapters = [];

    /*
     * Verified Rawkuma extractor structure:
     *
     * #chapter-list a:has(img)
     *
     * The chapter number is stored in the span/text.
     */
    $("#chapter-list a").each((_, element) => {
        const href = $(element).attr("href");

        if (!href) return;

        const url = absoluteUrl(href);

        if (!url) return;

        const text = $(element)
            .find("span")
            .first()
            .text()
            .trim() ||
            $(element)
                .text()
                .trim();

        const number =
            chapterNumber(text) ||
            chapterNumber(url);

        if (!number) return;

        chapters.push({
            number,
            text,
            url
        });
    });

    /*
     * Fallback if #chapter-list isn't returned exactly
     * as expected.
     */
    if (!chapters.length) {
        $("a[href]").each((_, element) => {
            const href = $(element).attr("href");

            if (!href) return;

            const url = absoluteUrl(href);

            if (!url) return;

            if (!url.includes("/manga/")) return;

            const text = $(element).text().trim();

            const number =
                chapterNumber(text) ||
                chapterNumber(url);

            if (!number) return;

            if (
                chapters.some(
                    item => item.url === url
                )
            ) {
                return;
            }

            chapters.push({
                number,
                text,
                url
            });
        });
    }

    return chapters;
}

/*
 * Extract actual reader pages.
 *
 * Rawkuma's current extractor uses:
 *
 * [data-image-data] img
 */
function extractPages(html) {
    const $ = cheerio.load(html);

    const pages = [];

    $("[data-image-data] img").each((_, element) => {
        const candidates = [
            $(element).attr("src"),
            $(element).attr("data-src"),
            $(element).attr("data-lazy-src"),
            $(element).attr("data-original")
        ];

        for (const value of candidates) {
            if (!value) continue;

            const url = absoluteUrl(value);

            if (!url) continue;

            const lower = url.toLowerCase();

            if (
                lower.includes("logo") ||
                lower.includes("avatar") ||
                lower.includes("icon") ||
                lower.includes("loading") ||
                lower.includes("spinner") ||
                lower.includes("rawkuma.jpg")
            ) {
                continue;
            }

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
     * Fallback selectors in case the theme changes.
     */
    if (!pages.length) {
        const selectors = [
            ".chapter-content img",
            ".reading-content img",
            "#chapter_images_container img",
            "article img"
        ];

        for (const selector of selectors) {
            $(selector).each((_, element) => {
                const candidates = [
                    $(element).attr("src"),
                    $(element).attr("data-src"),
                    $(element).attr("data-original"),
                    $(element).attr("data-lazy-src")
                ];

                for (const value of candidates) {
                    if (!value) continue;

                    const url = absoluteUrl(value);

                    if (!url) continue;

                    const lower = url.toLowerCase();

                    if (
                        lower.includes("logo") ||
                        lower.includes("avatar") ||
                        lower.includes("icon") ||
                        lower.includes("loading") ||
                        lower.includes("spinner") ||
                        lower.includes("rawkuma.jpg")
                    ) {
                        continue;
                    }

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

            if (pages.length) break;
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
     * 1. Find manga.
     */
    const manga = await findManga(title);

    if (!manga) {
        throw new Error(
            `Manga "${title}" was not found on Rawkuma.`
        );
    }

    /*
     * 2. Get chapter list through Rawkuma's AJAX endpoint.
     */
    const chapters = await getChapterList(manga);

    if (!chapters.length) {
        throw new Error(
            `Rawkuma found "${manga.title}", but returned no chapters.`
        );
    }

    /*
     * 3. Find exact requested chapter.
     */
    const wanted = String(chapter).trim();

    const selected = chapters.find(
        item => sameChapter(item.number, wanted)
    );

    if (!selected) {
        throw new Error(
            `Chapter ${chapter} was not found for "${manga.title}" on Rawkuma.`
        );
    }

    /*
     * 4. Open reader.
     */
    const reader = await client.get(
        selected.url,
        {
            headers: {
                Referer: manga.url
            }
        }
    );

    /*
     * 5. Extract pages.
     */
    const pages = extractPages(reader.data);

    if (!pages.length) {
        throw new Error(
            `Rawkuma found chapter ${chapter}, but no manga page images were extracted.`
        );
    }

    return {
        success: true,
        title: manga.title,
        chapter: String(chapter),
        source: "Rawkuma",
        pages
    };
}

module.exports = {
    name: "Rawkuma",
    getChapter
};
