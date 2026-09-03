const axios = require("axios");
const https = require("https");

const BASE_URL = "https://weebcentral.com";

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

function isPageImage(url) {
    if (!url) return false;

    const lower = url.toLowerCase();

    if (!/\.(jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(lower)) {
        return false;
    }

    /*
     * Reject obvious UI assets.
     */
    if (
        lower.includes("logo") ||
        lower.includes("avatar") ||
        lower.includes("icon") ||
        lower.includes("favicon")
    ) {
        return false;
    }

    return true;
}

function extractImages(html) {
    const images = new Set();

    const add = (url) => {
        url = cleanUrl(url);

        if (isPageImage(url)) {
            images.add(url);
        }
    };

    let match;

    /*
     * Normal/lazy images.
     */
    const imgRegex =
        /<img\b[^>]*(?:src|data-src|data-original|data-lazy-src|data-url)\s*=\s*["']([^"']+)["'][^>]*>/gi;

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
     * Direct image URLs embedded in JSON/HTML.
     */
    const absoluteRegex =
        /https?:\/\/[^"'\\\s<>]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'\\\s<>]*)?/gi;

    while ((match = absoluteRegex.exec(html)) !== null) {
        add(match[0]);
    }

    /*
     * data URLs / escaped URLs.
     */
    const decoded = html
        .replace(/\\u002F/gi, "/")
        .replace(/\\\//g, "/")
        .replace(/&quot;/gi, '"');

    while ((match = absoluteRegex.exec(decoded)) !== null) {
        add(match[0]);
    }

    return Array.from(images);
}

function extractChapterLinks(html, chapter) {
    const links = [];

    const target = String(chapter)
        .replace(/^chapter\s*/i, "")
        .trim();

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = cleanUrl(match[1]);

        if (!href) continue;

        if (!href.includes("/chapters/")) {
            continue;
        }

        const text = match[2]
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const combined = `${href} ${text}`;

        const numberPattern =
            new RegExp(
                `(?:chapter|ch(?:apter)?)\\s*${target}(?:\\D|$)`,
                "i"
            );

        if (numberPattern.test(combined)) {
            if (!links.includes(href)) {
                links.push(href);
            }
        }
    }

    return links;
}

function extractSeriesLinks(html, title) {
    const links = [];

    const wanted = normalizeTitle(title);

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = cleanUrl(match[1]);

        if (!href) continue;

        if (!href.includes("/series/")) {
            continue;
        }

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
            score >= Math.max(
                1,
                Math.ceil(words.length * 0.6)
            )
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
     * Known WeebCentral series URLs contain an ID before
     * the title slug, so direct slug-only URLs are not enough.
     *
     * Search first.
     */
    const searchUrls = [
        `${BASE_URL}/search/data?text=${encodeURIComponent(title)}`,
        `${BASE_URL}/search?text=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/${encodeURIComponent(title)}`
    ];

    const tried = new Set();

    /*
     * Direct series slug fallback.
     */
    const directSeriesUrls = [
        `${BASE_URL}/series/${slug}`,
        `${BASE_URL}/series/${slug}/`
    ];

    const seriesUrls = [
        ...directSeriesUrls
    ];

    /*
     * Search.
     */
    for (const searchUrl of searchUrls) {
        try {
            const response = await client.get(searchUrl);

            if (response.status !== 200) {
                continue;
            }

            const links = extractSeriesLinks(
                response.data,
                title
            );

            for (const link of links) {
                if (!seriesUrls.includes(link)) {
                    seriesUrls.push(link);
                }
            }
        } catch {
            // Continue.
        }
    }

    /*
     * Process series pages.
     */
    for (const seriesUrl of seriesUrls) {
        if (tried.has(seriesUrl)) continue;

        tried.add(seriesUrl);

        try {
            const response = await client.get(seriesUrl);

            if (response.status !== 200) {
                continue;
            }

            const html = response.data;

            /*
             * Find chapter link in the normal HTML.
             */
            let chapterLinks =
                extractChapterLinks(
                    html,
                    chapterNumber
                );

            /*
             * Some HTMX fragments can be embedded as
             * attributes or returned by chapter endpoints.
             */
            if (chapterLinks.length === 0) {
                const chapterRegex =
                    /https?:\/\/weebcentral\.com\/chapters\/[^"'\\\s<>]+/gi;

                let match;

                while (
                    (match = chapterRegex.exec(html)) !== null
                ) {
                    const url = cleanUrl(match[0]);

                    if (
                        url &&
                        new RegExp(
                            `(?:chapter|ch)[^0-9]*${chapterNumber}(?:\\D|$)`,
                            "i"
                        ).test(url)
                    ) {
                        if (!chapterLinks.includes(url)) {
                            chapterLinks.push(url);
                        }
                    }
                }
            }

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

                    const pages = extractImages(
                        chapterResponse.data
                    );

                    if (pages.length > 0) {
                        return {
                            title,
                            chapter: chapterNumber,
                            source: "WeebCentral",
                            pages
                        };
                    }
                } catch {
                    // Continue.
                }
            }

            /*
             * If the series page itself contains images,
             * use them only if this was clearly a chapter URL.
             */
            if (
                seriesUrl.includes("/chapters/") &&
                extractImages(html).length > 0
            ) {
                return {
                    title,
                    chapter: chapterNumber,
                    source: "WeebCentral",
                    pages: extractImages(html)
                };
            }
        } catch {
            // Continue.
        }
    }

    throw new Error(
        `No manga pages found on WeebCentral for "${title}" chapter ${chapterNumber}.`
    );
}

module.exports = {
    name: "WeebCentral",
    getChapter
};
