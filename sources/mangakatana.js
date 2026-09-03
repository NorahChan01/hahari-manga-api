const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangakatana.com";

const agent = new https.Agent({
    rejectUnauthorized: false
});

const client = axios.create({
    httpsAgent: agent,
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE_URL + "/"
    }
});

function normalizeTitle(title) {
    return String(title || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function slugify(title) {
    return normalizeTitle(title)
        .replace(/\s+/g, "-");
}

function cleanUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/g, "&")
        .replace(/\\\//g, "/")
        .trim();

    if (url.startsWith("//")) {
        url = "https:" + url;
    }

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

function extractImages(html) {
    const images = new Set();

    const add = (url) => {
        url = cleanUrl(url);

        if (!url) return;

        const lower = url.toLowerCase();

        if (
            !/\.(jpg|jpeg|png|webp|gif)(?:[?#].*)?$/i.test(lower)
        ) {
            return;
        }

        if (
            lower.includes("logo") ||
            lower.includes("avatar") ||
            lower.includes("icon")
        ) {
            return;
        }

        images.add(url);
    };

    let match;

    /*
     * img/src/data-src.
     */
    const imgRegex =
        /<img\b[^>]*(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;

    while ((match = imgRegex.exec(html)) !== null) {
        add(match[1]);
    }

    /*
     * srcset.
     */
    const srcsetRegex =
        /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcsetRegex.exec(html)) !== null) {
        for (const item of match[1].split(",")) {
            add(item.trim().split(/\s+/)[0]);
        }
    }

    /*
     * Absolute image URLs embedded in scripts/JSON.
     */
    const absoluteRegex =
        /https?:\/\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = absoluteRegex.exec(html)) !== null) {
        add(match[0]);
    }

    return Array.from(images);
}

function extractMangaLinks(html, title) {
    const links = [];

    const wanted = normalizeTitle(title);

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = cleanUrl(match[1]);

        if (!href) continue;

        if (!href.includes("/manga/")) continue;

        const text = normalizeTitle(
            match[2].replace(/<[^>]+>/g, " ")
        );

        const combined = normalizeTitle(
            `${href} ${text}`
        );

        if (
            combined.includes(wanted) ||
            wanted
                .split(" ")
                .filter(Boolean)
                .every(word => combined.includes(word))
        ) {
            if (!links.includes(href)) {
                links.push(href);
            }
        }
    }

    return links;
}

function extractChapterLinks(html, chapter) {
    const links = [];

    const wanted = String(chapter).trim();

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = cleanUrl(match[1]);

        if (!href) continue;

        const text = match[2]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const combined = `${href} ${text}`;

        const chapterRegex = new RegExp(
            `(?:chapter|ch)[\\s_-]*${wanted}(?:\\D|$)`,
            "i"
        );

        if (chapterRegex.test(combined)) {
            if (!links.includes(href)) {
                links.push(href);
            }
        }
    }

    return links;
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (!chapter) {
        throw new Error("Chapter number is required.");
    }

    const chapterNumber = String(chapter)
        .replace(/^chapter\s*/i, "")
        .trim();

    const slug = slugify(title);

    const directUrls = [
        `${BASE_URL}/manga/${slug}`,
        `${BASE_URL}/manga/${slug}/`,
        `${BASE_URL}/manga/${slug}/chapter-${chapterNumber}`,
        `${BASE_URL}/manga/${slug}/chapter-${chapterNumber}/`
    ];

    const tried = new Set();

    /*
     * Try direct manga page and chapter page.
     */
    for (const url of directUrls) {
        if (tried.has(url)) continue;

        tried.add(url);

        try {
            const response = await client.get(url);

            if (response.status !== 200) continue;

            const html = response.data;

            const pages = extractImages(html);

            /*
             * Direct chapter page.
             */
            if (pages.length > 0) {
                const chapterLinks =
                    extractChapterLinks(
                        html,
                        chapterNumber
                    );

                /*
                 * If the page itself contains actual
                 * chapter images, return them.
                 */
                if (
                    url.includes("chapter-") ||
                    chapterLinks.length === 0
                ) {
                    return {
                        title,
                        chapter: chapterNumber,
                        source: "MangaKatana",
                        pages
                    };
                }
            }

            /*
             * Manga info page -> locate chapter URL.
             */
            const chapterLinks =
                extractChapterLinks(
                    html,
                    chapterNumber
                );

            for (const chapterUrl of chapterLinks) {
                if (tried.has(chapterUrl)) continue;

                tried.add(chapterUrl);

                try {
                    const chapterResponse =
                        await client.get(chapterUrl);

                    if (
                        chapterResponse.status !== 200
                    ) {
                        continue;
                    }

                    const chapterPages =
                        extractImages(
                            chapterResponse.data
                        );

                    if (chapterPages.length > 0) {
                        return {
                            title,
                            chapter: chapterNumber,
                            source: "MangaKatana",
                            pages: chapterPages
                        };
                    }
                } catch {
                    // Continue.
                }
            }
        } catch {
            // Continue.
        }
    }

    /*
     * Search fallback.
     */
    const searchUrls = [
        `${BASE_URL}/search?search=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/${encodeURIComponent(title)}`
    ];

    for (const searchUrl of searchUrls) {
        try {
            const response = await client.get(searchUrl);

            if (response.status !== 200) continue;

            const mangaLinks = extractMangaLinks(
                response.data,
                title
            );

            for (const mangaUrl of mangaLinks) {
                const mangaResponse =
                    await client.get(mangaUrl);

                if (mangaResponse.status !== 200) {
                    continue;
                }

                const chapterLinks =
                    extractChapterLinks(
                        mangaResponse.data,
                        chapterNumber
                    );

                for (const chapterUrl of chapterLinks) {
                    if (tried.has(chapterUrl)) continue;

                    tried.add(chapterUrl);

                    try {
                        const chapterResponse =
                            await client.get(chapterUrl);

                        if (
                            chapterResponse.status !== 200
                        ) {
                            continue;
                        }

                        const pages =
                            extractImages(
                                chapterResponse.data
                            );

                        if (pages.length > 0) {
                            return {
                                title,
                                chapter: chapterNumber,
                                source: "MangaKatana",
                                pages
                            };
                        }
                    } catch {
                        // Continue.
                    }
                }
            }
        } catch {
            // Continue.
        }
    }

    throw new Error(
        `No manga pages found on MangaKatana for "${title}" chapter ${chapterNumber}.`
    );
}

module.exports = {
    name: "MangaKatana",
    getChapter
};
