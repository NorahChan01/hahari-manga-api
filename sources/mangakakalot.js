const axios = require("axios");
const https = require("https");

const BASE_URL = "https://www.mangakakalot.gg";

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

function isImage(url) {
    if (!url) return false;

    const lower = url.toLowerCase();

    if (!/\.(jpg|jpeg|png|webp|gif)(?:[?#].*)?$/i.test(lower)) {
        return false;
    }

    if (
        lower.includes("logo") ||
        lower.includes("avatar") ||
        lower.includes("icon")
    ) {
        return false;
    }

    return true;
}

function extractImages(html) {
    const images = new Set();

    const add = (url) => {
        url = cleanUrl(url);

        if (!isImage(url)) return;

        images.add(url);
    };

    /*
     * Normal img tags.
     */
    const imgRegex =
        /<img\b[^>]*(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;

    let match;

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
     * MangaKakalot image CDN.
     *
     * Example currently used by MangaKakalot:
     * https://img-r1.2xstorage.com/...
     */
    const cdnRegex =
        /https?:\/\/img-[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = cdnRegex.exec(html)) !== null) {
        add(match[0]);
    }

    /*
     * Relative image URLs.
     */
    const relativeRegex =
        /(?:src|data-src|data-original)\s*=\s*["']([^"']+)["']/gi;

    while ((match = relativeRegex.exec(html)) !== null) {
        add(match[1]);
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

        const words = wanted.split(" ").filter(Boolean);

        const score = words.filter(word =>
            combined.includes(word)
        ).length;

        if (
            combined.includes(wanted) ||
            score >= Math.max(1, Math.ceil(words.length * 0.6))
        ) {
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

    /*
     * MangaKakalot uses slug-based manga pages.
     *
     * We try the direct chapter first.
     */
    const directUrls = [
        `${BASE_URL}/chapter/${slug}/chapter_${chapterNumber}`,
        `${BASE_URL}/chapter/${slug}/chapter-${chapterNumber}`,
        `${BASE_URL}/chapter/${slug}/${chapterNumber}`,
        `${BASE_URL}/manga/${slug}/chapter_${chapterNumber}`
    ];

    const tried = new Set();

    for (const url of directUrls) {
        if (tried.has(url)) continue;

        tried.add(url);

        try {
            const response = await client.get(url);

            if (response.status !== 200) continue;

            const html = response.data;

            if (
                typeof html !== "string" ||
                html.length < 500
            ) {
                continue;
            }

            const pages = extractImages(html);

            if (pages.length > 0) {
                return {
                    title,
                    chapter: chapterNumber,
                    source: "MangaKakalot",
                    pages
                };
            }
        } catch {
            // Try next URL.
        }
    }

    /*
     * Search fallback.
     */
    const searchUrls = [
        `${BASE_URL}/search/${encodeURIComponent(title)}`,
        `${BASE_URL}/search/${encodeURIComponent(
            title.toLowerCase()
        )}`
    ];

    for (const searchUrl of searchUrls) {
        try {
            const response = await client.get(searchUrl);

            if (response.status !== 200) continue;

            const links = extractMangaLinks(
                response.data,
                title
            );

            for (const mangaUrl of links) {
                const base = mangaUrl.replace(/\/$/, "");

                const chapterUrls = [
                    `${base}/chapter_${chapterNumber}`,
                    `${base}/chapter-${chapterNumber}`,
                    `${base}/${chapterNumber}`
                ];

                for (const chapterUrl of chapterUrls) {
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

                        const pages = extractImages(
                            chapterResponse.data
                        );

                        if (pages.length > 0) {
                            return {
                                title,
                                chapter: chapterNumber,
                                source: "MangaKakalot",
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
        `No manga pages found on MangaKakalot for "${title}" chapter ${chapterNumber}.`
    );
}

module.exports = {
    name: "MangaKakalot",
    getChapter
};
