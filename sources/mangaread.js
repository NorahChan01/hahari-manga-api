const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.mangaread.org";

const client = axios.create({
    timeout: 25000,
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

function getChapterNumber(text) {
    const match = String(text || "")
        .match(/chapter[\s\-]*(\d+(?:\.\d+)?)/i);

    if (match) {
        return match[1];
    }

    const number = String(text || "")
        .match(/\b(\d+(?:\.\d+)?)\b/);

    return number ? number[1] : null;
}

function scoreTitle(found, wanted) {
    const a = normalize(found);
    const b = normalize(wanted);

    if (!a || !b) return 0;

    if (a === b) return 1000;
    if (a.includes(b)) return 850;
    if (b.includes(a)) return 800;

    const aa = new Set(a.split(/\s+/));
    const bb = new Set(b.split(/\s+/));

    let common = 0;

    for (const word of aa) {
        if (bb.has(word)) {
            common++;
        }
    }

    return common * 20;
}

function absoluteUrl(url) {
    if (!url) return null;

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

async function searchManga(title) {
    const wanted = normalize(title);

    // MangaRead uses WordPress/Madara-style manga pages.
    // First try the site's search endpoint.
    const searchUrls = [
        `${BASE_URL}/?s=${encodeURIComponent(title)}&post_type=wp-manga`,
        `${BASE_URL}/?s=${encodeURIComponent(title)}`
    ];

    for (const searchUrl of searchUrls) {
        try {
            const response = await client.get(searchUrl);

            const $ = cheerio.load(response.data);
            const results = [];

            $("a").each((_, el) => {
                const href = $(el).attr("href");
                const text = $(el).text().trim();

                if (!href || !text) return;

                const url = absoluteUrl(href);

                if (!url) return;

                if (
                    !url.includes("/manga/") ||
                    url.includes("/chapter-")
                ) {
                    return;
                }

                const score = scoreTitle(text, title);

                if (score > 0) {
                    if (
                        !results.some(
                            item => item.url === url
                        )
                    ) {
                        results.push({
                            title: text,
                            url,
                            score
                        });
                    }
                }
            });

            if (results.length) {
                results.sort(
                    (a, b) => b.score - a.score
                );

                return results[0];
            }
        } catch (_) {}
    }

    // Direct slug fallback.
    const slug = slugify(title);

    const directUrls = [
        `${BASE_URL}/manga/${slug}/`,
        `${BASE_URL}/manga/${slug}`
    ];

    for (const url of directUrls) {
        try {
            const response = await client.get(url);

            if (response.status !== 200) {
                continue;
            }

            const $ = cheerio.load(response.data);

            const pageTitle =
                $("div.summary_content h1").first().text().trim() ||
                $("h1").first().text().trim() ||
                title;

            if (
                response.data.includes("wp-manga") ||
                response.data.includes("wp-manga-chapter") ||
                response.data.includes("summary_content")
            ) {
                return {
                    title: pageTitle,
                    url
                };
            }
        } catch (_) {}
    }

    return null;
}

async function findChapterUrl(mangaUrl, chapter) {
    const response = await client.get(mangaUrl);

    const $ = cheerio.load(response.data);

    const wanted = String(chapter)
        .replace(",", ".")
        .trim();

    let exactUrl = null;

    // This is the actual MangaRead chapter structure:
    // <li class="wp-manga-chapter">
    //   <a href="...">Chapter 1111</a>
    // </li>
    $("li.wp-manga-chapter a").each((_, el) => {
        if (exactUrl) return;

        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href) return;

        const number = getChapterNumber(text);

        if (
            number === wanted ||
            normalize(text) ===
                normalize(`Chapter ${chapter}`)
        ) {
            exactUrl = absoluteUrl(href);
        }
    });

    if (exactUrl) {
        return exactUrl;
    }

    // Broader fallback in case the theme changes.
    $("a").each((_, el) => {
        if (exactUrl) return;

        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href) return;

        const url = absoluteUrl(href);

        if (!url || !url.includes("/chapter-")) {
            return;
        }

        const number =
            getChapterNumber(text) ||
            getChapterNumber(url);

        if (number === wanted) {
            exactUrl = url;
        }
    });

    return exactUrl;
}

function extractPages(html) {
    const $ = cheerio.load(html);

    const pages = [];

    // Official extractor structure:
    // div.reading-content
    // img#image-*
    $("div.reading-content img").each((_, el) => {
        const candidates = [
            $(el).attr("src"),
            $(el).attr("data-src"),
            $(el).attr("data-lazy-src"),
            $(el).attr("data-original")
        ];

        for (const value of candidates) {
            if (!value) continue;

            const url = absoluteUrl(value);

            if (!url) continue;

            // Reject obvious UI assets.
            const lower = url.toLowerCase();

            if (
                lower.includes("logo") ||
                lower.includes("avatar") ||
                lower.includes("icon") ||
                lower.includes("loading") ||
                lower.includes("reader-win")
            ) {
                continue;
            }

            // Manga pages should be image files.
            if (
                /\.(jpg|jpeg|png|webp|avif)(\?.*)?$/i.test(url)
            ) {
                if (!pages.includes(url)) {
                    pages.push(url);
                }

                break;
            }
        }
    });

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

    // 1. Find manga.
    const manga = await searchManga(title);

    if (!manga) {
        throw new Error(
            `Manga "${title}" was not found on MangaRead.`
        );
    }

    // 2. Find exact chapter URL.
    const chapterUrl = await findChapterUrl(
        manga.url,
        chapter
    );

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${chapter} was not found for "${title}" on MangaRead.`
        );
    }

    // 3. Open reader.
    const response = await client.get(
        chapterUrl,
        {
            headers: {
                Referer: manga.url
            }
        }
    );

    // 4. Extract actual manga pages.
    const pages = extractPages(response.data);

    if (!pages.length) {
        throw new Error(
            `MangaRead chapter ${chapter} was found, but no real page images were extracted.`
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
