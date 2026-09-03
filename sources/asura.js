const axios = require("axios");

const BASE_URL = "https://asurascans.com";

const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function scoreTitle(query, title) {
    const a = normalize(query);
    const b = normalize(title);

    if (!a || !b) return 0;
    if (a === b) return 100;

    if (b.includes(a)) return 95;
    if (a.includes(b)) return 90;

    const aw = new Set(a.split(" "));
    const bw = new Set(b.split(" "));

    let matches = 0;

    for (const word of aw) {
        if (bw.has(word)) matches++;
    }

    return (matches / Math.max(aw.size, bw.size)) * 100;
}

function cleanText(html) {
    return String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/*
 * Current Asura uses /comics/<slug-id>.
 *
 * We search the current homepage/browse pages instead of
 * assuming an old REST API exists.
 */
async function searchManga(query) {
    const pages = [
        "/",
        "/comics/"
    ];

    const candidates = new Map();

    for (const page of pages) {
        try {
            const response = await client.get(page);

            const html = response.data;

            const regex =
                /href=["'](\/comics\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

            let match;

            while ((match = regex.exec(html))) {
                const url = match[1];

                const rawText = match[2];

                const text = cleanText(rawText);

                if (!url || !text) continue;

                /*
                 * Avoid chapter links.
                 */
                if (url.includes("/chapter/")) continue;

                if (!candidates.has(url)) {
                    candidates.set(url, {
                        url: new URL(url, BASE_URL).href,
                        title: text
                    });
                }
            }
        } catch (error) {
            console.log(
                `Asura search ${page} failed:`,
                error.message
            );
        }
    }

    const results = [...candidates.values()]
        .map(item => ({
            ...item,
            score: scoreTitle(query, item.title)
        }))
        .sort((a, b) => b.score - a.score);

    /*
     * Current homepage may only expose a limited selection.
     * If the requested title isn't there, use Asura's browse
     * pages as additional discovery.
     */
    return results.slice(0, 20);
}

function extractComicLinks(html) {
    const results = new Map();

    const regex =
        /href=["'](\/comics\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const url = match[1];

        if (url.includes("/chapter/")) continue;

        const text = cleanText(match[2]);

        if (!text) continue;

        if (!results.has(url)) {
            results.set(url, {
                url: new URL(url, BASE_URL).href,
                title: text
            });
        }
    }

    return [...results.values()];
}

/*
 * Asura's current browse page is server-rendered.
 * Try several common browse routes.
 */
async function browseForManga(query) {
    const routes = [
        "/comics",
        "/comics/",
        "/browse",
        "/browse/"
    ];

    const all = new Map();

    for (const route of routes) {
        try {
            const response = await client.get(route);

            for (const item of extractComicLinks(response.data)) {
                if (!all.has(item.url)) {
                    all.set(item.url, item);
                }
            }
        } catch (error) {
            console.log(
                `Asura browse ${route} failed:`,
                error.message
            );
        }
    }

    const ranked = [...all.values()]
        .map(item => ({
            ...item,
            score: scoreTitle(query, item.title)
        }))
        .sort((a, b) => b.score - a.score);

    return ranked;
}

function extractChapterLinks(html) {
    const results = [];

    const regex =
        /href=["'](\/comics\/[^"'?#]+\/chapter\/[^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const url = match[1];

        const text = cleanText(match[2]);

        const chapterMatch =
            text.match(/chapter\s+(\d+(?:\.\d+)?)/i);

        if (!chapterMatch) continue;

        results.push({
            url: new URL(url, BASE_URL).href,
            number: chapterMatch[1],
            text
        });
    }

    /*
     * Remove duplicate chapter URLs.
     */
    const unique = new Map();

    for (const item of results) {
        if (!unique.has(item.url)) {
            unique.set(item.url, item);
        }
    }

    return [...unique.values()];
}

function extractImageUrls(html) {
    const urls = new Set();

    /*
     * Current Asura pages expose the reader images through
     * Astro island props. Look for JSON properties named url.
     */
    const urlRegex =
        /["']url["']\s*:\s*["'](https?:\/\/[^"']+)["']/gi;

    let match;

    while ((match = urlRegex.exec(html))) {
        let url = match[1];

        url = url
            .replace(/\\u0026/g, "&")
            .replace(/\\\//g, "/")
            .replace(/\\"/g, '"');

        if (
            /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url) ||
            url.includes("cdn.asurascans.com")
        ) {
            urls.add(url);
        }
    }

    /*
     * Fallback: normal img src.
     */
    const imgRegex =
        /<img[^>]+(?:src|data-src)=["'](https?:\/\/[^"']+)["']/gi;

    while ((match = imgRegex.exec(html))) {
        let url = match[1];

        url = url
            .replace(/\\u0026/g, "&")
            .replace(/\\\//g, "/");

        if (
            /\.(jpg|jpeg|png|webp)(\?|$)/i.test(url) ||
            url.includes("cdn.asurascans.com")
        ) {
            urls.add(url);
        }
    }

    return [...urls].filter(url => {
        const lower = url.toLowerCase();

        return (
            !lower.includes("logo") &&
            !lower.includes("favicon") &&
            !lower.includes("avatar") &&
            !lower.includes("icon")
        );
    });
}

async function getChapter(mangaUrl, chapterNumber) {
    const mangaPath = new URL(mangaUrl).pathname;

    const response = await client.get(mangaPath);

    const mangaHtml = response.data;

    const chapters = extractChapterLinks(mangaHtml);

    if (!chapters.length) {
        throw new Error(
            "No chapters were found on the Asura manga page."
        );
    }

    const requested = String(chapterNumber);

    let chapter = chapters.find(
        item => item.number === requested
    );

    if (!chapter) {
        chapter = chapters.find(
            item =>
                Number(item.number) ===
                Number(requested)
        );
    }

    if (!chapter) {
        throw new Error(
            `Chapter ${chapterNumber} was not found on Asura Scans.`
        );
    }

    const chapterPath =
        new URL(chapter.url).pathname;

    const chapterResponse =
        await client.get(chapterPath);

    const html = chapterResponse.data;

    const pages = extractImageUrls(html);

    if (!pages.length) {
        throw new Error(
            "Asura chapter was found, but no reader images were extracted."
        );
    }

    return {
        chapter: chapter.number,
        pages
    };
}

module.exports = {
    name: "Asura Scans",

    async getChapter(mangaName, chapterNumber) {
        let mangas = await searchManga(mangaName);

        /*
         * If homepage discovery didn't find the manga,
         * search browse pages.
         */
        if (
            !mangas.length ||
            mangas[0].score < 50
        ) {
            mangas = await browseForManga(mangaName);
        }

        if (!mangas.length) {
            throw new Error(
                `No manga found for "${mangaName}" on Asura Scans.`
            );
        }

        const manga = mangas[0];

        console.log(
            `[Asura] Selected: ${manga.title}`
        );

        console.log(
            `[Asura] URL: ${manga.url}`
        );

        const result = await getChapter(
            manga.url,
            chapterNumber
        );

        return {
            title: manga.title || mangaName,
            chapter: result.chapter,
            source: "Asura Scans",
            pages: result.pages
        };
    }
};
