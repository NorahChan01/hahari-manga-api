const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangapark.cc";

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/139.0.0.0 Safari/537.36",

    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,image/apng,*/*;q=0.8",

    "Accept-Language":
        "en-US,en;q=0.9",

    "Referer":
        BASE_URL + "/",

    "Cache-Control":
        "no-cache"
};

function slugify(text) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function absoluteUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/gi, "&")
        .replace(/\\\//g, "/")
        .trim();

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

function extractImages(html) {
    const pages = [];
    const seen = new Set();

    function add(url) {
        url = absoluteUrl(url);

        if (!url) return;

        if (
            /favicon|logo|avatar|icon|sprite|banner|advert|ads\./i.test(
                url
            )
        ) {
            return;
        }

        if (
            !/\.(?:jpg|jpeg|png|webp|gif)(?:[?#]|$)/i.test(
                url
            )
        ) {
            return;
        }

        if (seen.has(url)) return;

        seen.add(url);
        pages.push(url);
    }

    let match;

    /*
     * img src
     */
    const srcRegex =
        /<(?:img|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcRegex.exec(html))) {
        add(match[1]);
    }

    /*
     * Lazy images.
     */
    const lazyRegex =
        /<(?:img|source)\b[^>]*?(?:data-src|data-original|data-lazy-src|data-image|data-url)\s*=\s*["']([^"']+)["']/gi;

    while ((match = lazyRegex.exec(html))) {
        add(match[1]);
    }

    /*
     * srcset.
     */
    const srcsetRegex =
        /\bsrcset\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcsetRegex.exec(html))) {
        for (const item of match[1].split(",")) {
            add(item.trim().split(/\s+/)[0]);
        }
    }

    /*
     * Direct image URLs inside JavaScript/JSON.
     */
    const directRegex =
        /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = directRegex.exec(html))) {
        add(
            match[0]
                .replace(/\\\//g, "/")
                .replace(/\\"/g, '"')
        );
    }

    return pages;
}

async function request(url, referer = BASE_URL + "/") {
    try {
        const response = await axios.get(url, {
            headers: {
                ...HEADERS,
                Referer: referer
            },

            httpsAgent,

            timeout: 30000,

            maxRedirects: 10,

            validateStatus: status =>
                status >= 200 && status < 400
        });

        return response.data;
    } catch (error) {
        if (error.response) {
            throw new Error(
                `HTTP ${error.response.status}`
            );
        }

        throw new Error(
            error.message ||
            "MangaPark request failed."
        );
    }
}

async function getChapter(title, chapter) {
    const cleanTitle =
        String(title || "").trim();

    const cleanChapter =
        String(chapter || "").trim();

    if (!cleanTitle) {
        throw new Error(
            "Manga title is required."
        );
    }

    if (!cleanChapter) {
        throw new Error(
            "Chapter number is required."
        );
    }

    /*
     * MangaPark current URL structure:
     *
     * /manga/girl-and-science
     */
    const slug =
        slugify(cleanTitle);

    const mangaUrl =
        `${BASE_URL}/manga/${slug}`;

    /*
     * Don't try to validate the manga page by
     * searching its HTML. Just open it.
     */
    const mangaHtml =
        await request(mangaUrl);

    /*
     * Current MangaPark reader structure:
     *
     * /read/girl-and-science/en/chapter-20
     */
    const chapterUrl =
        `${BASE_URL}/read/${slug}/en/chapter-${encodeURIComponent(cleanChapter)}`;

    let chapterHtml;

    try {
        chapterHtml =
            await request(
                chapterUrl,
                mangaUrl
            );
    } catch (error) {

        /*
         * If the predictable URL fails, inspect the
         * manga page for an actual /read/ link.
         */
        const readLinks = [];

        const regex =
            /href\s*=\s*["']([^"']*\/read\/[^"']+)["']/gi;

        let match;

        while ((match = regex.exec(mangaHtml))) {
            const url =
                absoluteUrl(match[1]);

            if (!url) continue;

            if (
                new RegExp(
                    `chapter[-_]${cleanChapter}(?:[^0-9]|$)`,
                    "i"
                ).test(url)
            ) {
                readLinks.push(url);
            }
        }

        if (!readLinks.length) {
            throw new Error(
                `Chapter ${cleanChapter} not found on MangaPark.`
            );
        }

        chapterHtml =
            await request(
                readLinks[0],
                mangaUrl
            );
    }

    /*
     * Extract chapter pages.
     */
    const pages =
        extractImages(chapterHtml);

    if (!pages.length) {
        throw new Error(
            "MangaPark returned the chapter but no readable page images were found."
        );
    }

    return {
        title: cleanTitle,
        chapter: cleanChapter,
        source: "MangaPark",
        pages
    };
}

module.exports = {
    name: "MangaPark",

    async getChapter(title, chapter) {
        return await getChapter(
            title,
            chapter
        );
    }
};
