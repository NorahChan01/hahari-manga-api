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
            "image/avif,image/webp,image/apng,*/*;q=0.8",

        "Accept-Language":
            "en-US,en;q=0.9",

        "Cache-Control":
            "no-cache",

        "Referer":
            BASE_URL + "/"
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


function cleanText(text) {
    return String(text || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}


function cleanUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/gi, "&")
        .replace(/\\\//g, "/")
        .replace(/&quot;/gi, '"')
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


/*
 * Extract the WeebCentral series ID.
 *
 * Example:
 *
 * /series/01J76XY7E9FNDZ1DBBM6PBJPFK/One-Piece
 *
 * returns:
 *
 * 01J76XY7E9FNDZ1DBBM6PBJPFK
 */
function extractSeriesId(url) {
    if (!url) return null;

    const match = String(url).match(
        /\/series\/([^/?#]+)/i
    );

    return match ? match[1] : null;
}


/*
 * Extract chapter ID.
 *
 * Example:
 *
 * /chapters/01J76XZ812WKWQH58G74HPTWXX
 */
function extractChapterId(url) {
    if (!url) return null;

    const match = String(url).match(
        /\/chapters\/([^/?#]+)/i
    );

    return match ? match[1] : null;
}


/*
 * Parse WeebCentral search results.
 *
 * Current WeebCentral search uses:
 *
 * /search?text=TITLE
 *
 * Search results contain /series/{ID}/{slug}
 */
function extractSeriesLinks(html, title) {
    const results = [];

    const wanted = normalizeTitle(title);

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']*\/series\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = cleanUrl(match[1]);

        if (!href) continue;

        const text = normalizeTitle(
            cleanText(match[2])
        );

        const combined = normalizeTitle(
            `${href} ${text}`
        );

        const words = wanted
            .split(/\s+/)
            .filter(Boolean);

        let score = 0;

        for (const word of words) {
            if (combined.includes(word)) {
                score++;
            }
        }

        const percentage =
            words.length > 0
                ? score / words.length
                : 0;

        if (
            combined.includes(wanted) ||
            percentage >= 0.6
        ) {
            if (!results.includes(href)) {
                results.push(href);
            }
        }
    }

    return results;
}


/*
 * Extract chapter links from the full chapter list.
 *
 * WeebCentral chapter IDs do NOT contain the chapter
 * number, so we must read the visible chapter text.
 */
function extractChapterLinks(html, chapter) {
    const results = [];

    const wanted = String(chapter)
        .replace(/^chapter\s*/i, "")
        .trim();

    /*
     * WeebCentral chapter links.
     */
    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']*\/chapters\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html)) !== null) {
        const href = cleanUrl(match[1]);

        if (!href) continue;

        const text = cleanText(match[2]);

        /*
         * Extract the first chapter-like number.
         *
         * Examples:
         * Chapter 1111
         * Ch. 1111
         * 1111
         * Chapter 1111: Title
         */
        const numberMatch = text.match(
            /(?:chapter|ch\.?|#)?\s*(\d+(?:\.\d+)?)/i
        );

        if (!numberMatch) continue;

        const number = numberMatch[1];

        if (number === wanted) {
            if (!results.includes(href)) {
                results.push(href);
            }
        }
    }

    /*
     * Fallback: inspect surrounding HTML when the
     * chapter number is not directly inside <a>.
     */
    if (results.length === 0) {

        const escapedChapter =
            wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        const fallbackRegex =
            new RegExp(
                `<a\\b[^>]*href\\s*=\\s*["']([^"']*\\/chapters\\/[^"']+)["'][^>]*>[\\s\\S]{0,1200}?(?:chapter|ch\\.?|#)\\s*${escapedChapter}(?:\\D|$)`,
                "gi"
            );

        while (
            (match = fallbackRegex.exec(html)) !== null
        ) {
            const href = cleanUrl(match[1]);

            if (
                href &&
                !results.includes(href)
            ) {
                results.push(href);
            }
        }
    }

    return results;
}


/*
 * Extract images from the dedicated WeebCentral
 * /images?reading_style=long_strip endpoint.
 *
 * This is the important part.
 *
 * Current WeebCentral reader uses:
 *
 * section img[alt^="Page"]
 */
function extractReaderImages(html) {
    const images = [];

    /*
     * Primary selector equivalent:
     *
     * section img[alt^="Page"]
     *
     * We use regex because this adapter doesn't
     * depend on cheerio/jsdom.
     */
    const imgRegex =
        /<img\b([^>]*?)>/gi;

    let match;

    while ((match = imgRegex.exec(html)) !== null) {

        const attributes = match[1];

        /*
         * Only accept actual page images.
         */
        const altMatch =
            attributes.match(
                /\balt\s*=\s*["']([^"']*)["']/i
            );

        if (!altMatch) continue;

        const alt =
            altMatch[1].trim();

        if (!/^Page/i.test(alt)) {
            continue;
        }

        /*
         * WeebCentral normally exposes the image
         * through src.
         *
         * Also support lazy attributes just in case.
         */
        const srcMatch =
            attributes.match(
                /\b(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+)["']/i
            );

        if (!srcMatch) continue;

        const url =
            cleanUrl(srcMatch[1]);

        if (!url) continue;

        /*
         * Only actual image files.
         */
        if (
            !/\.(?:jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i
                .test(url)
        ) {
            continue;
        }

        if (!images.includes(url)) {
            images.push(url);
        }
    }

    /*
     * Fallback for image URLs inside HTML if the
     * normal <img alt="Page ..."> extraction failed.
     */
    if (images.length === 0) {

        const fallbackRegex =
            /<img\b[^>]*(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+)["'][^>]*>/gi;

        while (
            (match = fallbackRegex.exec(html)) !== null
        ) {

            const url =
                cleanUrl(match[1]);

            if (!url) continue;

            if (
                !/\.(?:jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i
                    .test(url)
            ) {
                continue;
            }

            /*
             * Reject obvious UI assets.
             */
            const lower =
                url.toLowerCase();

            if (
                lower.includes("logo") ||
                lower.includes("avatar") ||
                lower.includes("favicon") ||
                lower.includes("icon")
            ) {
                continue;
            }

            if (!images.includes(url)) {
                images.push(url);
            }
        }
    }

    return images;
}


/*
 * Get the current full chapter list.
 */
async function getChapterList(seriesId) {

    if (!seriesId) {
        throw new Error(
            "WeebCentral series ID is required."
        );
    }

    const url =
        `${BASE_URL}/series/${seriesId}/full-chapter-list`;

    const response =
        await client.get(url, {
            headers: {
                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                "Referer":
                    `${BASE_URL}/series/${seriesId}`
            }
        });

    if (response.status !== 200) {
        throw new Error(
            `WeebCentral chapter list returned HTTP ${response.status}.`
        );
    }

    return response.data;
}


/*
 * Find the series page for a title.
 */
async function findSeries(title) {

    const searchUrl =
        `${BASE_URL}/search?text=${encodeURIComponent(title)}`;

    try {

        const response =
            await client.get(searchUrl);

        if (response.status === 200) {

            const links =
                extractSeriesLinks(
                    response.data,
                    title
                );

            if (links.length > 0) {
                return links[0];
            }
        }

    } catch {
        // Continue to fallback.
    }

    /*
     * Some installations/search responses can expose
     * a series link in alternative HTML fragments.
     */
    const fallbackUrls = [
        `${BASE_URL}/search?text=${encodeURIComponent(title)}`
    ];

    for (const url of fallbackUrls) {

        try {

            const response =
                await client.get(url);

            const html =
                response.data || "";

            const direct =
                html.match(
                    /https?:\/\/weebcentral\.com\/series\/[^"'\\\s<>]+/i
                );

            if (direct) {
                return cleanUrl(direct[0]);
            }

        } catch {
            // Continue.
        }
    }

    return null;
}


/*
 * Main adapter.
 */
async function getChapter(title, chapter) {

    if (!title) {
        throw new Error(
            "Manga title is required."
        );
    }

    if (
        chapter === undefined ||
        chapter === null ||
        String(chapter).trim() === ""
    ) {
        throw new Error(
            "Chapter number is required."
        );
    }

    const chapterNumber =
        String(chapter)
            .replace(/^chapter\s*/i, "")
            .trim();

    /*
     * 1. Find the actual series URL.
     */
    const seriesUrl =
        await findSeries(title);

    if (!seriesUrl) {
        throw new Error(
            `Manga "${title}" was not found on WeebCentral.`
        );
    }

    const seriesId =
        extractSeriesId(seriesUrl);

    if (!seriesId) {
        throw new Error(
            `Could not extract WeebCentral series ID from ${seriesUrl}`
        );
    }

    /*
     * 2. Fetch the dedicated full chapter list.
     */
    const chapterListHtml =
        await getChapterList(seriesId);

    /*
     * 3. Find exact requested chapter.
     */
    const chapterLinks =
        extractChapterLinks(
            chapterListHtml,
            chapterNumber
        );

    if (chapterLinks.length === 0) {
        throw new Error(
            `Chapter ${chapterNumber} was not found on WeebCentral for "${title}".`
        );
    }

    /*
     * 4. Try every matching chapter URL.
     */
    for (const chapterUrl of chapterLinks) {

        const chapterId =
            extractChapterId(chapterUrl);

        if (!chapterId) continue;

        /*
         * IMPORTANT:
         *
         * We do NOT scrape the normal chapter page
         * for images.
         *
         * WeebCentral has a dedicated image endpoint.
         */
        const imagesUrl =
            `${BASE_URL}/chapters/${chapterId}/images?reading_style=long_strip`;

        try {

            const response =
                await client.get(
                    imagesUrl,
                    {
                        headers: {
                            "Accept":
                                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

                            "Referer":
                                chapterUrl
                        }
                    }
                );

            if (response.status !== 200) {
                continue;
            }

            const pages =
                extractReaderImages(
                    response.data
                );

            /*
             * Successful chapter.
             */
            if (pages.length > 0) {

                return {
                    title,
                    chapter: chapterNumber,
                    source: "WeebCentral",
                    pages
                };
            }

        } catch {
            // Try next chapter URL.
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
