const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangalivre.to";

const agent = new https.Agent({
    rejectUnauthorized: false
});

const client = axios.create({
    httpsAgent: agent,
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": BASE_URL + "/"
    }
});

function cleanUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/g, "&")
        .replace(/&#038;/g, "&")
        .replace(/\\\//g, "/")
        .trim();

    if (url.startsWith("//")) {
        url = "https:" + url;
    }

    if (url.startsWith("/")) {
        url = BASE_URL + url;
    }

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

function isReaderImage(url) {
    if (!url) return false;

    const lower = url.toLowerCase();

    // MangaLivre's actual WP-Manga reader storage.
    if (!lower.includes("/wp-content/uploads/wp-manga/data/")) {
        return false;
    }

    // Only actual image files.
    if (!/\.(webp|jpg|jpeg|png|gif)(?:[?#].*)?$/i.test(lower)) {
        return false;
    }

    // Reject obvious thumbnails/covers.
    if (
        lower.includes("/cover/") ||
        lower.includes("/covers/") ||
        lower.includes("thumbnail") ||
        lower.includes("thumb-")
    ) {
        return false;
    }

    return true;
}

function addImage(set, url) {
    url = cleanUrl(url);

    if (isReaderImage(url)) {
        set.add(url);
    }
}

function extractImages(html) {
    const images = new Set();

    /*
     * 1. Direct image attributes
     */
    const imgRegex =
        /<img\b[^>]*(?:src|data-src|data-lazy-src|data-original|data-image|data-url)\s*=\s*["']([^"']+)["'][^>]*>/gi;

    let match;

    while ((match = imgRegex.exec(html)) !== null) {
        addImage(images, match[1]);
    }

    /*
     * 2. srcset / data-srcset
     */
    const srcsetRegex =
        /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;

    while ((match = srcsetRegex.exec(html)) !== null) {
        const parts = match[1].split(",");

        for (const part of parts) {
            const url = part.trim().split(/\s+/)[0];
            addImage(images, url);
        }
    }

    /*
     * 3. Direct MangaLivre reader URLs anywhere in HTML.
     *
     * This catches images stored inside JavaScript,
     * JSON, lazy-loader objects, etc.
     */
    const readerRegex =
        /https?:\/\/mangalivre\.to\/wp-content\/uploads\/WP-manga\/data\/[^"'\\\s<>]+?\.(?:webp|jpg|jpeg|png|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = readerRegex.exec(html)) !== null) {
        addImage(images, match[0]);
    }

    /*
     * 4. Relative reader URLs.
     */
    const relativeRegex =
        /\/wp-content\/uploads\/WP-manga\/data\/[^"'\\\s<>]+?\.(?:webp|jpg|jpeg|png|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = relativeRegex.exec(html)) !== null) {
        addImage(images, match[0]);
    }

    /*
     * 5. CSS/background URLs.
     */
    const cssRegex =
        /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;

    while ((match = cssRegex.exec(html)) !== null) {
        addImage(images, match[1]);
    }

    /*
     * 6. Decode escaped JSON URLs.
     */
    const decoded = html
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&quot;/gi, '"');

    const decodedRegex =
        /https?:\/\/mangalivre\.to\/wp-content\/uploads\/WP-manga\/data\/[^"'\\\s<>]+?\.(?:webp|jpg|jpeg|png|gif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = decodedRegex.exec(decoded)) !== null) {
        addImage(images, match[0]);
    }

    return Array.from(images);
}

function normalizeTitle(title) {
    return String(title || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function slugify(title) {
    return normalizeTitle(title)
        .replace(/\s+/g, "-");
}

function normalizeChapter(chapter) {
    return String(chapter)
        .trim()
        .replace(/^chapter\s*/i, "")
        .replace(/^capitulo\s*/i, "")
        .trim();
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (!chapter) {
        throw new Error("Chapter number is required.");
    }

    const chapterNumber = normalizeChapter(chapter);
    const slug = slugify(title);

    /*
     * First try the most likely direct MangaLivre URL.
     */
    const directUrls = [
        `${BASE_URL}/manga/${slug}/capitulo-${chapterNumber}/`,
        `${BASE_URL}/manga/${slug}/capitulo-${chapterNumber}`,
        `${BASE_URL}/manga/${slug}/capitulo-${chapterNumber}/?style=paged`
    ];

    const tried = new Set();

    for (const url of directUrls) {
        if (tried.has(url)) continue;
        tried.add(url);

        try {
            const response = await client.get(url);

            if (response.status !== 200) {
                continue;
            }

            const html = response.data;

            const pages = extractImages(html);

            if (pages.length > 0) {
                return {
                    title: extractChapterTitle(html, title),
                    chapter: chapterNumber,
                    source: "MangaLivre",
                    pages
                };
            }
        } catch (err) {
            // Continue to search fallback URLs.
        }
    }

    /*
     * Search MangaLivre if the direct slug failed.
     */
    const searchUrls = [
        `${BASE_URL}/?s=${encodeURIComponent(title)}`,
        `${BASE_URL}/manga/?s=${encodeURIComponent(title)}`,
        `${BASE_URL}/?post_type=wp-manga&s=${encodeURIComponent(title)}`
    ];

    for (const searchUrl of searchUrls) {
        try {
            const response = await client.get(searchUrl);

            if (response.status !== 200) {
                continue;
            }

            const html = response.data;

            const mangaLinks = extractMangaLinks(html, title);

            for (const mangaUrl of mangaLinks) {
                const chapterUrls = [
                    `${mangaUrl.replace(/\/$/, "")}/capitulo-${chapterNumber}/`,
                    `${mangaUrl.replace(/\/$/, "")}/capitulo-${chapterNumber}`,
                    `${mangaUrl.replace(/\/$/, "")}/capitulo-${chapterNumber}/?style=paged`
                ];

                for (const chapterUrl of chapterUrls) {
                    if (tried.has(chapterUrl)) continue;
                    tried.add(chapterUrl);

                    try {
                        const chapterResponse = await client.get(chapterUrl);

                        if (chapterResponse.status !== 200) {
                            continue;
                        }

                        const pages = extractImages(chapterResponse.data);

                        if (pages.length > 0) {
                            return {
                                title: extractChapterTitle(
                                    chapterResponse.data,
                                    title
                                ),
                                chapter: chapterNumber,
                                source: "MangaLivre",
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
        `No manga pages found on MangaLivre for "${title}" chapter ${chapterNumber}.`
    );
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

        if (!href.includes("/manga/")) {
            continue;
        }

        if (
            href.includes("/capitulo-") ||
            href.includes("/chapter-")
        ) {
            continue;
        }

        const text = normalizeTitle(
            match[2].replace(/<[^>]+>/g, " ")
        );

        const combined = normalizeTitle(
            `${href} ${text}`
        );

        if (
            combined.includes(wanted) ||
            wanted.split(" ").every(word => combined.includes(word))
        ) {
            if (!links.includes(href)) {
                links.push(href);
            }
        }
    }

    return links;
}

function extractChapterTitle(html, fallback) {
    const match = html.match(
        /<h1\b[^>]*>([\s\S]*?)<\/h1>/i
    );

    if (!match) {
        return fallback;
    }

    const text = match[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    return text || fallback;
}

module.exports = {
    name: "MangaLivre",
    getChapter
};
