const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://mangabuddy.com";

const client = axios.create({
    timeout: 20000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function slugify(text) {
    return normalize(text).replace(/\s+/g, "-");
}

function extractImages(html) {
    const $ = cheerio.load(html);
    const images = [];

    $("img").each((_, el) => {
        const candidates = [
            $(el).attr("data-src"),
            $(el).attr("data-original"),
            $(el).attr("data-lazy-src"),
            $(el).attr("src")
        ];

        for (const url of candidates) {
            if (!url) continue;

            const clean = url.trim();

            if (
                /^https?:\/\//i.test(clean) &&
                /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(clean)
            ) {
                if (!images.includes(clean)) {
                    images.push(clean);
                }
                break;
            }
        }
    });

    return images;
}

async function searchManga(title) {
    const slug = slugify(title);

    const urls = [
        `${BASE_URL}/search?q=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/${encodeURIComponent(slug)}`
    ];

    for (const url of urls) {
        try {
            const response = await client.get(url);

            const $ = cheerio.load(response.data);
            const results = [];

            $("a").each((_, el) => {
                const href = $(el).attr("href");
                const text = $(el).text().trim();

                if (!href || !text) return;

                if (
                    href.includes("/manga/") &&
                    normalize(text).includes(normalize(title))
                ) {
                    results.push({
                        title: text,
                        url: new URL(href, BASE_URL).href
                    });
                }
            });

            if (results.length) {
                return results[0];
            }
        } catch (_) {}
    }

    // Try the normal slug directly
    try {
        const url = `${BASE_URL}/manga/${slug}`;
        const response = await client.get(url);

        if (response.status === 200) {
            const $ = cheerio.load(response.data);
            const pageTitle = $("h1").first().text().trim();

            if (pageTitle || response.data.includes("chapter")) {
                return {
                    title: pageTitle || title,
                    url
                };
            }
        }
    } catch (_) {}

    return null;
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (chapter === undefined || chapter === null || chapter === "") {
        throw new Error("Chapter number is required.");
    }

    const manga = await searchManga(title);

    if (!manga) {
        throw new Error(
            `Manga "${title}" was not found on MangaBuddy.`
        );
    }

    const mangaUrl = manga.url;

    const response = await client.get(mangaUrl);
    const $ = cheerio.load(response.data);

    let chapterUrl = null;

    $("a").each((_, el) => {
        if (chapterUrl) return;

        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href) return;

        const fullUrl = new URL(href, BASE_URL).href;

        const chapterText = normalize(text);
        const wanted = normalize(String(chapter));

        const match =
            chapterText === `chapter ${wanted}` ||
            chapterText === wanted ||
            chapterText.includes(`chapter ${wanted}`);

        if (match) {
            chapterUrl = fullUrl;
        }
    });

    if (!chapterUrl) {
        const slug = slugify(title);

        const possible = [
            `${BASE_URL}/chapter/${slug}-${chapter}`,
            `${BASE_URL}/${slug}-chapter-${chapter}`,
            `${BASE_URL}/chapter/${slug}/chapter-${chapter}`
        ];

        for (const url of possible) {
            try {
                const test = await client.get(url);

                if (test.status === 200) {
                    const imgs = extractImages(test.data);

                    if (imgs.length) {
                        chapterUrl = url;
                        break;
                    }
                }
            } catch (_) {}
        }
    }

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${chapter} was not found for "${title}" on MangaBuddy.`
        );
    }

    const chapterResponse = await client.get(chapterUrl);
    const pages = extractImages(chapterResponse.data);

    if (!pages.length) {
        throw new Error(
            `MangaBuddy chapter ${chapter} was found, but no page images were extracted.`
        );
    }

    return {
        success: true,
        title: manga.title || title,
        chapter: String(chapter),
        source: "MangaBuddy",
        pages
    };
}

module.exports = {
    name: "MangaBuddy",
    getChapter
};
