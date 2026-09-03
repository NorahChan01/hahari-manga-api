const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://manhuaplus.org";

const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL + "/"
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

function slugify(text) {
    return normalize(text).replace(/\s+/g, "-");
}

function extractChapterNumber(text) {
    const match = String(text || "").match(
        /chapter[\s._-]*([0-9]+(?:\.[0-9]+)?)/i
    );

    return match ? match[1] : null;
}

async function getMangaPage(title) {
    // First try the site's direct slug.
    const slug = slugify(title);

    const possibleUrls = [
        `/manga/${slug}`,
        `/manga/${slug}/`
    ];

    for (const url of possibleUrls) {
        try {
            const response = await client.get(url);

            if (
                response.status === 200 &&
                response.data &&
                /chapter/i.test(response.data)
            ) {
                return {
                    url: new URL(url, BASE_URL).href,
                    html: response.data
                };
            }
        } catch (_) {}
    }

    return null;
}

async function findChapter(mangaUrl, html, chapter) {
    const $ = cheerio.load(html);

    const wanted = normalize(String(chapter));

    let chapterUrl = null;

    $("a[href]").each((_, element) => {
        if (chapterUrl) return;

        const href = $(element).attr("href");
        const text = $(element).text().trim();

        if (!href) return;

        const combined = `${text} ${href}`;

        const number = extractChapterNumber(combined);

        if (number && normalize(number) === wanted) {
            chapterUrl = new URL(href, mangaUrl).href;
        }
    });

    if (chapterUrl) {
        return chapterUrl;
    }

    // Fallback to the site's normal URL pattern.
    const slug = mangaUrl
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .pop();

    if (slug) {
        return `${BASE_URL}/manga/${slug}/chapter-${chapter}`;
    }

    return null;
}

function extractChapterId(html) {
    const patterns = [
        /CHAPTER_ID\s*=\s*["']?(\d+)["']?/i,
        /CHAPTER_ID\s*:\s*["']?(\d+)["']?/i,
        /var\s+CHAPTER_ID\s*=\s*["']?(\d+)["']?/i,
        /let\s+CHAPTER_ID\s*=\s*["']?(\d+)["']?/i,
        /const\s+CHAPTER_ID\s*=\s*["']?(\d+)["']?/i
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);

        if (match) {
            return match[1];
        }
    }

    return null;
}

function extractImages(html) {
    const $ = cheerio.load(html);
    const images = [];

    // Preferred reader container.
    $(".page-chapter img").each((_, element) => {
        const src =
            $(element).attr("data-original") ||
            $(element).attr("data-src") ||
            $(element).attr("src");

        if (src) {
            images.push(src);
        }
    });

    // Some chapters use separator links instead.
    if (!images.length) {
        $(".separator").each((_, element) => {
            const link = $(element).find("a").attr("href");

            if (link) {
                images.push(link);
            }
        });
    }

    // Final fallback.
    if (!images.length) {
        $("img").each((_, element) => {
            const src =
                $(element).attr("data-original") ||
                $(element).attr("data-src") ||
                $(element).attr("src");

            if (src && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(src)) {
                images.push(src);
            }
        });
    }

    return images
        .map(url => {
            try {
                return new URL(url, BASE_URL).href;
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .filter((url, index, array) => array.indexOf(url) === index)
        .filter(url => !/rawwkuro\.jpg/i.test(url));
}

module.exports = {
    name: "ManhuaPlus",

    async getChapter(title, chapter) {
        if (!title || chapter === undefined || chapter === null) {
            throw new Error("Title and chapter are required.");
        }

        const manga = await getMangaPage(title);

        if (!manga) {
            throw new Error(
                `Manga "${title}" was not found on ManhuaPlus.`
            );
        }

        const chapterUrl = await findChapter(
            manga.url,
            manga.html,
            chapter
        );

        if (!chapterUrl) {
            throw new Error(
                `Chapter ${chapter} was not found for "${title}" on ManhuaPlus.`
            );
        }

        const chapterResponse = await client.get(chapterUrl, {
            headers: {
                Referer: manga.url
            }
        });

        const chapterHtml = chapterResponse.data;

        const chapterId = extractChapterId(chapterHtml);

        if (!chapterId) {
            throw new Error(
                `ManhuaPlus chapter ${chapter} did not expose a CHAPTER_ID.`
            );
        }

        const imageResponse = await client.post(
            `/ajax/image/list/chap/${chapterId}`,
            null,
            {
                headers: {
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": chapterUrl,
                    "Accept": "application/json, text/javascript, */*; q=0.01"
                }
            }
        );

        const imageHtml =
            imageResponse.data &&
            typeof imageResponse.data === "object"
                ? imageResponse.data.html
                : imageResponse.data;

        if (!imageHtml) {
            throw new Error(
                "ManhuaPlus returned no reader image data."
            );
        }

        const pages = extractImages(imageHtml);

        if (!pages.length) {
            throw new Error(
                `No manga pages found on ManhuaPlus for "${title}" chapter ${chapter}.`
            );
        }

        const $chapter = cheerio.load(chapterHtml);

        const detectedTitle =
            $chapter("h1").first().text().trim() ||
            $chapter("title").text().trim() ||
            title;

        return {
            title: detectedTitle
                .replace(/\s*-\s*Chapter.*$/i, "")
                .trim() || title,

            chapter: String(chapter),

            source: "ManhuaPlus",

            pages
        };
    }
};
