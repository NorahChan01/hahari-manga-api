const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.toongod.org";

const client = axios.create({
timeout: 30000,
maxRedirects: 5,
headers: {
"User-Agent":
"Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
"AppleWebKit/537.36 (KHTML, like Gecko) " +
"Chrome/139.0.0.0 Safari/537.36",
"Accept":
"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,/;q=0.8",
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

function absolute(url, base = BASE_URL) {
try {
return new URL(url, base).href;
} catch {
return null;
}
}

function unique(array) {
return [...new Set(
array
.filter(Boolean)
.map(x => x.trim())
)];
}

function sameChapter(a, b) {
if (a == null) return false;

const x = String(a).trim();
const y = String(b).trim();

if (x === y) return true;

const nx = Number(x);
const ny = Number(y);

return (
    Number.isFinite(nx) &&
    Number.isFinite(ny) &&
    nx === ny
);

}

function extractChapterNumber(text) {
const value = String(text || "");

const patterns = [
    /chapter[\s._-]*(\d+(?:\.\d+)?)/i,
    /chap[\s._-]*(\d+(?:\.\d+)?)/i,
    /\bc[\s._-]*(\d+(?:\.\d+)?)(?:[^\d]|$)/i
];

for (const regex of patterns) {
    const match = value.match(regex);

    if (match) {
        return match[1];
    }
}

return null;

}

function isImage(url) {
if (!url) return false;

const lower = url.toLowerCase();

if (
    lower.includes("logo") ||
    lower.includes("avatar") ||
    lower.includes("favicon") ||
    lower.includes("icon") ||
    lower.includes("banner")
) {
    return false;
}

return (
    /\.(jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(url) ||
    lower.includes("/uploads/") ||
    lower.includes("/chapter/")
);

}

function getImageFromElement($, el) {
const attributes = [
"data-src",
"data-lazy-src",
"data-original",
"data-url",
"src"
];

for (const attribute of attributes) {
    const value = $(el).attr(attribute);

    if (
        value &&
        !value.startsWith("data:image")
    ) {
        return value;
    }
}

return null;

}

async function searchManga(title) {
const wanted = normalize(title);

if (!wanted) {
    return null;
}

const searchUrls = [
    `${BASE_URL}/?s=${encodeURIComponent(title)}`,
    `${BASE_URL}/search/${encodeURIComponent(title)}/`
];

const candidates = [];

for (const searchUrl of searchUrls) {
    try {
        const response =
            await client.get(searchUrl);

        const $ =
            cheerio.load(response.data);

        $("a[href*='/webtoon/']").each((_, el) => {
            const href =
                $(el).attr("href");

            if (!href) return;

            const text =
                $(el).attr("title") ||
                $(el).text().trim();

            if (!text) return;

            const name =
                text
                    .replace(/\s+/g, " ")
                    .trim();

            const normalized =
                normalize(name);

            let score = 0;

            if (normalized === wanted) {
                score = 100;
            } else if (
                normalized.includes(wanted)
            ) {
                score = 85;
            } else if (
                wanted.includes(normalized)
            ) {
                score = 75;
            } else {
                const wantedWords =
                    wanted.split(" ");

                const candidateWords =
                    normalized.split(" ");

                const common =
                    wantedWords.filter(
                        word =>
                            word.length > 2 &&
                            candidateWords.includes(word)
                    ).length;

                score =
                    common * 10;
            }

            candidates.push({
                title: name,
                url: absolute(href),
                score
            });
        });

    } catch (error) {
        console.log(
            `[ToonGod] Search failed: ${error.message}`
        );
    }
}

const filtered =
    candidates.filter(
        (item, index, array) =>
            item.url &&
            array.findIndex(
                x => x.url === item.url
            ) === index
    );

filtered.sort(
    (a, b) => b.score - a.score
);

return filtered[0] || null;

}

async function findChapter(manga, chapter) {
const response =
await client.get(
manga.url,
{
headers: {
Referer: BASE_URL + "/"
}
}
);

const $ =
    cheerio.load(response.data);

let chapterUrl = null;

$("a[href]").each((_, el) => {
    if (chapterUrl) return;

    const href =
        $(el).attr("href");

    const text =
        $(el).text().trim();

    if (!href) return;

    const combined =
        `${text} ${href}`;

    const number =
        extractChapterNumber(
            combined
        );

    if (
        sameChapter(
            number,
            chapter
        )
    ) {
        chapterUrl =
            absolute(
                href,
                manga.url
            );
    }
});

return chapterUrl;

}

async function extractPages(chapterUrl) {
const response =
await client.get(
chapterUrl,
{
headers: {
Referer: chapterUrl
}
}
);

const html =
    response.data;

const $ =
    cheerio.load(html);

const pages = [];

const selectors = [
    ".reading-content img",
    ".chapter-content img",
    ".reading-detail img",
    ".page-break img",
    ".chapter-reader img",
    ".c-tabs-item__content img",
    ".main-reading-area img"
];

for (const selector of selectors) {
    $(selector).each((_, el) => {
        const raw =
            getImageFromElement(
                $,
                el
            );

        const url =
            absolute(
                raw,
                chapterUrl
            );

        if (
            url &&
            isImage(url)
        ) {
            pages.push(url);
        }
    });
}

/*
 * Fallback:
 * inspect every image on the page.
 */
if (pages.length < 2) {
    $("img").each((_, el) => {
        const raw =
            getImageFromElement(
                $,
                el
            );

        const url =
            absolute(
                raw,
                chapterUrl
            );

        if (
            url &&
            isImage(url)
        ) {
            pages.push(url);
        }
    });
}

/*
 * Search inline JavaScript for image URLs.
 *
 * IMPORTANT:
 * This regex is intentionally written as a
 * JavaScript regex literal. Do not remove the
 * surrounding /.../gi.
 */
$("script").each((_, el) => {
    const script =
        $(el).html() || "";

    const matches =
        script.match(
            /https?:\/\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\\\s]*)?/gi
        );

    if (!matches) return;

    for (const match of matches) {
        const clean =
            match
                .replace(
                    /\\u0026/g,
                    "&"
                )
                .replace(
                    /\\\//g,
                    "/"
                );

        if (isImage(clean)) {
            pages.push(clean);
        }
    }
});

return unique(pages);

}

module.exports = {
name: "ToonGod",

async getChapter(
    title,
    chapter
) {
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
        `[ToonGod] Searching: ${title} chapter ${chapter}`
    );

    const manga =
        await searchManga(title);

    if (!manga) {
        throw new Error(
            `Manga "${title}" was not found on ToonGod.`
        );
    }

    console.log(
        `[ToonGod] Found manga: ${manga.title}`
    );

    const chapterUrl =
        await findChapter(
            manga,
            chapter
        );

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${chapter} was not found for "${manga.title}" on ToonGod.`
        );
    }

    console.log(
        `[ToonGod] Chapter URL: ${chapterUrl}`
    );

    const pages =
        await extractPages(
            chapterUrl
        );

    if (pages.length < 2) {
        throw new Error(
            `ToonGod chapter was found, but no usable manga pages were extracted for "${manga.title}" chapter ${chapter}.`
        );
    }

    return {
        title:
            manga.title || title,

        chapter:
            String(chapter),

        source:
            "ToonGod",

        pages
    };
}

};
