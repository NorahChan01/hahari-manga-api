const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://mangahub.io";

const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
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

function extractChapterNumber(text) {
    const match = String(text || "").match(
        /(?:chapter|ch\.?|episode|ep\.?)[\s._-]*([0-9]+(?:\.[0-9]+)?)/i
    );

    return match ? match[1] : null;
}

function sameChapter(value, wanted) {
    if (!value) return false;

    const a = String(value).trim();
    const b = String(wanted).trim();

    return a === b ||
        Number(a) === Number(b);
}

function absolute(url) {
    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

async function searchManga(title) {
    const response = await client.get("/search", {
        params: {
            q: title,
            genre: "all",
            order: "ALPHABET"
        }
    });

    const $ = cheerio.load(response.data);

    const wanted = normalize(title);
    const candidates = [];

    $("a[href*='/manga/']").each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href || !text) return;

        const cleanText = text
            .replace(/\s+/g, " ")
            .trim();

        const normalized = normalize(cleanText);

        let score = 0;

        if (normalized === wanted) score = 100;
        else if (normalized.includes(wanted)) score = 80;
        else if (wanted.includes(normalized)) score = 70;

        candidates.push({
            title: cleanText,
            url: absolute(href),
            score
        });
    });

    // Remove duplicates.
    const unique = [];

    for (const item of candidates) {
        if (!item.url) continue;

        if (!unique.some(x => x.url === item.url)) {
            unique.push(item);
        }
    }

    unique.sort((a, b) => b.score - a.score);

    if (!unique.length) {
        return null;
    }

    return unique[0];
}

async function getChapterFromManga(manga, chapter) {
    const response = await client.get(manga.url);

    const $ = cheerio.load(response.data);

    let chapterUrl = null;

    $("a[href]").each((_, el) => {
        if (chapterUrl) return;

        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href) return;

        const combined = `${text} ${href}`;
        const number = extractChapterNumber(combined);

        if (sameChapter(number, chapter)) {
            chapterUrl = absolute(href);
        }
    });

    if (chapterUrl) {
        return chapterUrl;
    }

    // MangaHub commonly uses chapter-{number}.
    const slug = manga.url
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .pop();

    if (slug) {
        const fallback = `${BASE_URL}/chapter/${slug}-chapter-${chapter}`;

        try {
            const test = await client.get(fallback);

            if (test.status === 200) {
                return fallback;
            }
        } catch (_) {}
    }

    return null;
}

function extractImages(html) {
    const $ = cheerio.load(html);
    const pages = [];

    $("img").each((_, el) => {
        const src =
            $(el).attr("data-src") ||
            $(el).attr("data-original") ||
            $(el).attr("src");

        if (!src) return;

        const url = absolute(src);

        if (!url) return;

        if (
            /\.(jpg|jpeg|png|webp)(?:\?|$)/i.test(url) ||
            /image|chapter|manga|upload/i.test(url)
        ) {
            pages.push(url);
        }
    });

    // MangaHub's image page can contain links to the actual images.
    $("a[href]").each((_, el) => {
        const href = $(el).attr("href");

        if (!href) return;

        const url = absolute(href);

        if (!url) return;

        if (/\.(jpg|jpeg|png|webp)(?:\?|$)/i.test(url)) {
            pages.push(url);
        }
    });

    return pages.filter(
        (url, index, array) =>
            array.indexOf(url) === index
    );
}

module.exports = {
    name: "MangaHub",

    async getChapter(title, chapter) {
        if (!title || chapter === undefined || chapter === null) {
            throw new Error("Title and chapter are required.");
        }

        const manga = await searchManga(title);

        if (!manga) {
            throw new Error(
                `Manga "${title}" was not found on MangaHub.`
            );
        }

        const chapterUrl = await getChapterFromManga(
            manga,
            chapter
        );

        if (!chapterUrl) {
            throw new Error(
                `Chapter ${chapter} was not found for "${title}" on MangaHub.`
            );
        }

        const chapterResponse = await client.get(chapterUrl, {
            headers: {
                Referer: manga.url
            }
        });

        const pages = extractImages(chapterResponse.data);

        if (!pages.length) {
            throw new Error(
                `No manga pages found on MangaHub for "${title}" chapter ${chapter}.`
            );
        }

        return {
            title: manga.title || title,
            chapter: String(chapter),
            source: "MangaHub",
            pages
        };
    }
};
