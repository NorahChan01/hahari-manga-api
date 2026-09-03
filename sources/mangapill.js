const axios = require("axios");

const BASE_URL = "https://mangapill.com";

const client = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL + "/"
    }
});

function cleanText(text) {
    return String(text || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTitle(title) {
    return cleanText(title)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function decodeHtml(value) {
    return String(value || "")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#x2F;/gi, "/")
        .replace(/\\u002F/g, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/");
}

function absoluteUrl(url) {
    if (!url) return null;

    url = decodeHtml(url).trim();

    if (url.startsWith("//")) {
        return "https:" + url;
    }

    if (url.startsWith("/")) {
        return BASE_URL + url;
    }

    if (/^https?:\/\//i.test(url)) {
        return url;
    }

    return null;
}

function extractMangaResults(html) {
    const results = [];
    const seen = new Set();

    /*
     * Current MangaPill search results contain links such as:
     * /manga/123/title-name
     */

    const regex =
        /<a[^>]+href=["']([^"']*\/manga\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const href = absoluteUrl(match[1]);

        if (!href || !/\/manga\/[^/?#]+/i.test(href)) {
            continue;
        }

        const block = match[2];

        let title = "";

        // Prefer the visible title inside the result card.
        const titleMatch =
            block.match(
                /<(?:div|span|p)[^>]*class=["'][^"']*(?:leading-tight|manga-title|title)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p)>/i
            );

        if (titleMatch) {
            title = cleanText(titleMatch[1]);
        }

        if (!title) {
            title = cleanText(block);
        }

        if (!title) {
            const slug = href
                .split("/manga/")[1]
                .split(/[?#]/)[0]
                .replace(/^\d+\//, "")
                .replace(/[-_]+/g, " ");

            title = cleanText(slug);
        }

        const key = href.split("#")[0];

        if (!seen.has(key)) {
            seen.add(key);
            results.push({
                title,
                url: href
            });
        }
    }

    return results;
}

function scoreTitle(query, title) {
    const q = normalizeTitle(query);
    const t = normalizeTitle(title);

    if (!q || !t) return 0;

    if (q === t) return 1000;

    if (t.includes(q)) return 800;
    if (q.includes(t)) return 700;

    const qWords = new Set(q.split(" ").filter(Boolean));
    const tWords = new Set(t.split(" ").filter(Boolean));

    let common = 0;

    for (const word of qWords) {
        if (tWords.has(word)) {
            common++;
        }
    }

    if (!common) return 0;

    return Math.round((common / Math.max(qWords.size, tWords.size)) * 500);
}

async function searchManga(title) {
    const url =
        `${BASE_URL}/search?q=${encodeURIComponent(title)}` +
        `&type=manga&status=`;

    const response = await client.get(url);

    const results = extractMangaResults(response.data);

    if (!results.length) {
        throw new Error("No MangaPill manga results found.");
    }

    results.sort((a, b) => {
        return scoreTitle(title, b.title) - scoreTitle(title, a.title);
    });

    return results[0];
}

function extractChapterLinks(html) {
    const chapters = [];
    const seen = new Set();

    /*
     * Current MangaPill chapter links use:
     * /chapters/<id>/<slug>-chapter-<number>
     */

    const regex =
        /<a[^>]+href=["']([^"']*\/chapters\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const href = absoluteUrl(match[1]);

        if (!href || !/\/chapters\//i.test(href)) {
            continue;
        }

        const text = cleanText(match[2]);

        const urlPart = href
            .split("/chapters/")[1]
            .split(/[?#]/)[0];

        const combined = `${text} ${urlPart}`;

        /*
         * Supports:
         * Chapter 214
         * Ch. 214
         * #214
         * 214
         * 214.5
         * 214.2
         */

        const numbers = [
            ...combined.matchAll(
                /(?:chapter|ch\.?|#)\s*([0-9]+(?:\.[0-9]+)?)/gi
            )
        ];

        let chapterNumber = null;

        if (numbers.length) {
            chapterNumber = numbers[numbers.length - 1][1];
        } else {
            const fallback =
                urlPart.match(/chapter[-_ ]?([0-9]+(?:\.[0-9]+)?)/i);

            if (fallback) {
                chapterNumber = fallback[1];
            }
        }

        if (!chapterNumber) {
            continue;
        }

        const key = href.split("#")[0];

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        chapters.push({
            number: chapterNumber,
            url: href,
            text
        });
    }

    return chapters;
}

function normalizeChapter(value) {
    return String(value)
        .trim()
        .replace(/^ch(?:apter)?\.?\s*/i, "")
        .replace(/^#/, "");
}

function chapterMatches(found, requested) {
    const a = normalizeChapter(found);
    const b = normalizeChapter(requested);

    if (a === b) return true;

    /*
     * Handles values such as:
     * 58.2
     * 58
     */

    const na = Number(a);
    const nb = Number(b);

    return Number.isFinite(na) &&
        Number.isFinite(nb) &&
        na === nb;
}

function extractImages(html) {
    const images = [];
    const seen = new Set();

    /*
     * First target the reader images.
     * MangaPill has used both .js-page and chapter-page/picture
     * image structures.
     */

    const imageRegex =
        /<img\b([^>]*?)>/gi;

    let match;

    while ((match = imageRegex.exec(html))) {
        const attrs = match[1];

        let url = null;

        const dataSrc =
            attrs.match(
                /\bdata-src\s*=\s*["']([^"']+)["']/i
            );

        const src =
            attrs.match(
                /\bsrc\s*=\s*["']([^"']+)["']/i
            );

        const dataOriginal =
            attrs.match(
                /\bdata-original\s*=\s*["']([^"']+)["']/i
            );

        const dataLazy =
            attrs.match(
                /\bdata-lazy-src\s*=\s*["']([^"']+)["']/i
            );

        if (dataSrc) {
            url = dataSrc[1];
        } else if (dataOriginal) {
            url = dataOriginal[1];
        } else if (dataLazy) {
            url = dataLazy[1];
        } else if (src) {
            url = src[1];
        }

        url = absoluteUrl(url);

        if (!url) continue;

        const lower = url.toLowerCase();

        /*
         * Ignore site UI assets, logos and covers.
         */

        if (
            lower.includes("/static/") ||
            lower.includes("logo") ||
            lower.includes("favicon") ||
            lower.includes("avatar") ||
            lower.includes("/covers/") ||
            lower.includes("/cover/")
        ) {
            continue;
        }

        /*
         * MangaPill reader images normally come from image/CDN
         * locations rather than the site's UI.
         */

        if (
            !/\.(?:jpg|jpeg|png|webp|gif)(?:[?#].*)?$/i.test(lower)
        ) {
            continue;
        }

        if (!seen.has(url)) {
            seen.add(url);
            images.push(url);
        }
    }

    return images;
}

async function getChapterImages(chapterUrl) {
    const response = await client.get(chapterUrl, {
        headers: {
            Referer: BASE_URL + "/"
        }
    });

    const images = extractImages(response.data);

    if (!images.length) {
        throw new Error("No reader images found on MangaPill chapter page.");
    }

    return images;
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (chapter === undefined || chapter === null || chapter === "") {
        throw new Error("Chapter number is required.");
    }

    const manga = await searchManga(title);

    if (!manga || !manga.url) {
        throw new Error(`Manga not found: ${title}`);
    }

    const mangaPage = await client.get(manga.url, {
        headers: {
            Referer: BASE_URL + "/search?q=" + encodeURIComponent(title)
        }
    });

    const chapters = extractChapterLinks(mangaPage.data);

    if (!chapters.length) {
        throw new Error(
            `No chapters found for "${manga.title}" on MangaPill.`
        );
    }

    const requested = normalizeChapter(chapter);

    let selected = chapters.find(c =>
        chapterMatches(c.number, requested)
    );

    /*
     * Fallback: inspect chapter URL/text directly.
     */

    if (!selected) {
        selected = chapters.find(c => {
            const combined =
                `${c.number} ${c.text} ${c.url}`;

            return new RegExp(
                `(?:chapter|ch\\.?|#)\\s*${requested}(?:\\D|$)`,
                "i"
            ).test(combined);
        });
    }

    if (!selected) {
        throw new Error(
            `Chapter ${chapter} not found for "${manga.title}" on MangaPill.`
        );
    }

    const pages = await getChapterImages(selected.url);

    return {
        title: manga.title,
        chapter: selected.number,
        source: "MangaPill",
        pages
    };
}

module.exports = {
    name: "MangaPill",

    async getChapter(title, chapter) {
        return getChapter(title, chapter);
    }
};
