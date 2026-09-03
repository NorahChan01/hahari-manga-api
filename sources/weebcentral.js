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

        "Referer":
            BASE_URL + "/"
    }
});


function cleanUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/&amp;/gi, "&")
        .replace(/\\\//g, "/")
        .replace(/&quot;/gi, '"')
        .trim();

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
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


function normalizeTitle(title) {
    return String(title || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}


/*
 * Extract the series ID from:
 *
 * https://weebcentral.com/series/01J76XY7E9FNDZ1DBBM6PBJPFK/One-Piece
 */
function getSeriesId(url) {
    const match = String(url || "").match(
        /\/series\/([^/?#]+)/i
    );

    return match ? match[1] : null;
}


/*
 * Extract chapter ID from:
 *
 * https://weebcentral.com/chapters/XXXXXXXX
 */
function getChapterId(url) {
    const match = String(url || "").match(
        /\/chapters\/([^/?#]+)/i
    );

    return match ? match[1] : null;
}


/*
 * Search WeebCentral.
 *
 * IMPORTANT:
 * Current WeebCentral uses /search/data with these
 * parameters. This is the format used by current
 * third-party WeebCentral implementations.
 */
async function searchSeries(title) {

    const url =
        `${BASE_URL}/search/data` +
        `?limit=32` +
        `&offset=0` +
        `&text=${encodeURIComponent(title)}` +
        `&sort=Best+Match` +
        `&order=Ascending` +
        `&official=Any` +
        `&display_mode=Minimal%20Display`;

    const response = await client.get(url, {
        headers: {
            "Referer":
                `${BASE_URL}/search?text=${encodeURIComponent(title)}`
        }
    });

    if (response.status !== 200) {
        throw new Error(
            `WeebCentral search returned HTTP ${response.status}.`
        );
    }

    const html = response.data || "";

    const results = [];

    /*
     * Current search results are article elements.
     *
     * The actual manga link is:
     *
     * article > a.link.link-hover
     */
    const articleRegex =
        /<article\b[^>]*>([\s\S]*?)<\/article>/gi;

    let articleMatch;

    while (
        (articleMatch = articleRegex.exec(html)) !== null
    ) {

        const article = articleMatch[1];

        const linkMatch =
            article.match(
                /<a\b[^>]*class\s*=\s*["'][^"']*\blink\b[^"']*\blink-hover\b[^"']*["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i
            );

        if (!linkMatch) continue;

        const url = cleanUrl(linkMatch[1]);

        if (!url || !/\/series\//i.test(url)) {
            continue;
        }

        /*
         * Try to get the visible title from the article.
         */
        const text = cleanText(article);

        const wanted = normalizeTitle(title);
        const normalizedText = normalizeTitle(text);

        const words =
            wanted
                .split(/\s+/)
                .filter(Boolean);

        let score = 0;

        for (const word of words) {
            if (normalizedText.includes(word)) {
                score++;
            }
        }

        const ratio =
            words.length
                ? score / words.length
                : 0;

        results.push({
            url,
            score: ratio,
            text
        });
    }


    /*
     * Fallback parser.
     *
     * Some responses may not preserve the exact
     * article structure.
     */
    if (results.length === 0) {

        const linkRegex =
            /<a\b[^>]*href\s*=\s*["']([^"']*\/series\/[^"']+)["'][^>]*>/gi;

        let match;

        while (
            (match = linkRegex.exec(html)) !== null
        ) {

            const url =
                cleanUrl(match[1]);

            if (!url) continue;

            if (!results.some(x => x.url === url)) {
                results.push({
                    url,
                    score: 0,
                    text: ""
                });
            }
        }
    }


    /*
     * Sort best matching title first.
     */
    results.sort(
        (a, b) => b.score - a.score
    );

    return results;
}


/*
 * Fetch the complete chapter list.
 */
async function fetchChapterList(seriesId) {

    const url =
        `${BASE_URL}/series/${seriesId}/full-chapter-list`;

    const response =
        await client.get(url, {
            headers: {
                "Referer":
                    `${BASE_URL}/series/${seriesId}`
            }
        });

    if (response.status !== 200) {
        throw new Error(
            `WeebCentral chapter list returned HTTP ${response.status}.`
        );
    }

    return response.data || "";
}


/*
 * Parse chapters from the current WeebCentral
 * full-chapter-list HTML.
 *
 * Current structure uses:
 *
 * div.flex.items-center
 *
 * with:
 *
 * a[href*="/chapters/"]
 *
 * and the chapter number inside:
 *
 * .grow span
 */
function parseChapters(html) {

    const chapters = [];

    /*
     * First try the current container structure.
     */
    const containerRegex =
        /<div\b[^>]*class\s*=\s*["'][^"']*\bflex\b[^"']*\bitems-center\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;

    let containerMatch;

    while (
        (containerMatch =
            containerRegex.exec(html)) !== null
    ) {

        const block =
            containerMatch[1];

        const linkMatch =
            block.match(
                /<a\b[^>]*href\s*=\s*["']([^"']*\/chapters\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i
            );

        if (!linkMatch) continue;

        const url =
            cleanUrl(linkMatch[1]);

        if (!url) continue;

        const linkContent =
            linkMatch[2];

        const text =
            cleanText(linkContent);

        const numberMatch =
            text.match(
                /(?:chapter|ch\.?|#)?\s*(\d+(?:\.\d+)?)/i
            );

        if (!numberMatch) continue;

        const number =
            parseFloat(numberMatch[1]);

        const id =
            getChapterId(url);

        if (!id) continue;

        if (
            !chapters.some(
                c => c.id === id
            )
        ) {
            chapters.push({
                id,
                number,
                title: text,
                url
            });
        }
    }


    /*
     * More permissive fallback.
     */
    if (chapters.length === 0) {

        const linkRegex =
            /<a\b[^>]*href\s*=\s*["']([^"']*\/chapters\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

        let match;

        while (
            (match = linkRegex.exec(html)) !== null
        ) {

            const url =
                cleanUrl(match[1]);

            if (!url) continue;

            const text =
                cleanText(match[2]);

            const numberMatch =
                text.match(
                    /(?:chapter|ch\.?|#)?\s*(\d+(?:\.\d+)?)/i
                );

            if (!numberMatch) continue;

            const number =
                parseFloat(numberMatch[1]);

            const id =
                getChapterId(url);

            if (!id) continue;

            if (
                !chapters.some(
                    c => c.id === id
                )
            ) {
                chapters.push({
                    id,
                    number,
                    title: text,
                    url
                });
            }
        }
    }


    return chapters;
}


/*
 * Extract actual reader images.
 *
 * Current WeebCentral reader supports:
 *
 * /chapters/{id}/images?reading_style=long_strip
 */
function extractImages(html) {

    const images = [];

    /*
     * Preferred:
     *
     * section img[alt^="Page"]
     */
    const pageRegex =
        /<img\b([^>]*\balt\s*=\s*["']Page[^"']*["'][^>]*)>/gi;

    let match;

    while (
        (match = pageRegex.exec(html)) !== null
    ) {

        const attrs =
            match[1];

        const srcMatch =
            attrs.match(
                /\b(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+)["']/i
            );

        if (!srcMatch) continue;

        const url =
            cleanUrl(srcMatch[1]);

        if (!url) continue;

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
     * General fallback.
     */
    if (images.length === 0) {

        const imgRegex =
            /<img\b([^>]+)>/gi;

        while (
            (match = imgRegex.exec(html)) !== null
        ) {

            const attrs =
                match[1];

            const srcMatch =
                attrs.match(
                    /\b(?:src|data-src|data-lazy-src|data-original)\s*=\s*["']([^"']+)["']/i
                );

            if (!srcMatch) continue;

            const url =
                cleanUrl(srcMatch[1]);

            if (!url) continue;

            if (
                !/\.(?:jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i
                    .test(url)
            ) {
                continue;
            }

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
 * Main source method.
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

    const wantedNumber =
        parseFloat(chapterNumber);


    /*
     * STEP 1
     * Search WeebCentral using /search/data.
     */
    const searchResults =
        await searchSeries(title);

    if (searchResults.length === 0) {
        throw new Error(
            `Manga "${title}" was not found on WeebCentral.`
        );
    }


    /*
     * Try the best few search results rather than
     * blindly trusting the first result.
     */
    const candidates =
        searchResults.slice(0, 5);


    for (const result of candidates) {

        const seriesId =
            getSeriesId(result.url);

        if (!seriesId) continue;


        try {

            /*
             * STEP 2
             * Get complete chapter list.
             */
            const chapterHtml =
                await fetchChapterList(seriesId);

            const chapters =
                parseChapters(chapterHtml);

            if (chapters.length === 0) {
                continue;
            }


            /*
             * STEP 3
             * Find exact chapter.
             */
            let selected =
                chapters.find(
                    c =>
                        Number(c.number) ===
                        Number(wantedNumber)
                );


            /*
             * Handle numbers such as 1.0.
             */
            if (!selected) {

                selected =
                    chapters.find(
                        c =>
                            String(c.number) ===
                            String(wantedNumber)
                    );
            }


            if (!selected) {
                continue;
            }


            /*
             * STEP 4
             * Fetch dedicated reader image endpoint.
             */
            const imagesUrl =
                `${BASE_URL}/chapters/${selected.id}` +
                `/images?reading_style=long_strip`;

            const response =
                await client.get(
                    imagesUrl,
                    {
                        headers: {
                            "Referer":
                                `${BASE_URL}/chapters/${selected.id}`
                        }
                    }
                );


            if (response.status !== 200) {
                continue;
            }


            /*
             * STEP 5
             * Extract manga pages.
             */
            const pages =
                extractImages(
                    response.data
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
            /*
             * Try the next matching search result.
             */
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
