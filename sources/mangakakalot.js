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

        "Accept-Language":
            "en-US,en;q=0.9",

        "Cache-Control":
            "no-cache",

        "Pragma":
            "no-cache",

        "Referer":
            BASE_URL + "/"
    }
});


/* =========================================================
   HELPERS
========================================================= */

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


function normalizeChapter(chapter) {
    return String(chapter || "")
        .trim()
        .replace(/^chapter\s*/i, "")
        .replace(/^ch\.?\s*/i, "")
        .trim();
}


function cleanUrl(url) {
    if (!url) {
        return null;
    }

    let value = String(url)
        .replace(/&amp;/gi, "&")
        .replace(/&#038;/gi, "&")
        .replace(/\\\//g, "/")
        .replace(/\\"/g, '"')
        .trim();

    if (
        value.startsWith("//")
    ) {
        value = "https:" + value;
    }

    try {
        return new URL(value, BASE_URL).href;
    } catch {
        return null;
    }
}


/* =========================================================
   MANGAKAKALOT IMAGE VALIDATION
========================================================= */

function isMangaPageImage(url) {
    if (!url) {
        return false;
    }

    const lower = url.toLowerCase();

    /*
     * MangaKakalot currently uses the 2xstorage
     * image servers for reader pages.
     */
    const validHost =
        lower.includes("img-r1.2xstorage.com") ||
        lower.includes("img-r2.2xstorage.com") ||
        lower.includes("imgs-2.2xstorage.com") ||
        lower.includes("storage.waitst.com");

    if (!validHost) {
        return false;
    }

    /*
     * Reader files are normally WEBP/JPG/PNG.
     */
    if (
        !/\.(webp|jpg|jpeg|png|gif)(?:[?#].*)?$/i.test(lower)
    ) {
        return false;
    }

    /*
     * Reject obvious non-reader assets.
     */
    if (
        lower.includes("/logo") ||
        lower.includes("/icon") ||
        lower.includes("/avatar") ||
        lower.includes("/favicon")
    ) {
        return false;
    }

    return true;
}


/* =========================================================
   IMAGE EXTRACTION
========================================================= */

function extractImages(html) {
    const images = new Set();

    if (
        typeof html !== "string" ||
        !html
    ) {
        return [];
    }


    function addImage(rawUrl) {
        const url = cleanUrl(rawUrl);

        if (
            url &&
            isMangaPageImage(url)
        ) {
            images.add(url);
        }
    }


    let match;


    /*
     * -----------------------------------------------------
     * 1. Standard <img src="">
     * -----------------------------------------------------
     */

    const imgRegex =
        /<img\b[^>]*(?:src|data-src|data-original|data-lazy-src|data-url)\s*=\s*["']([^"']+)["'][^>]*>/gi;

    while (
        (match = imgRegex.exec(html)) !== null
    ) {
        addImage(match[1]);
    }


    /*
     * -----------------------------------------------------
     * 2. srcset
     * -----------------------------------------------------
     */

    const srcsetRegex =
        /(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;

    while (
        (match = srcsetRegex.exec(html)) !== null
    ) {
        const values = match[1].split(",");

        for (const value of values) {
            const url = value
                .trim()
                .split(/\s+/)[0];

            addImage(url);
        }
    }


    /*
     * -----------------------------------------------------
     * 3. Direct 2xstorage URLs
     *
     * Example:
     * https://img-r1.2xstorage.com/
     * hajime-no-ippo/1191/0.webp
     * -----------------------------------------------------
     */

    const storageRegex =
        /https?:\/\/(?:img-r1|img-r2|imgs-2)\.2xstorage\.com\/[^"'<>\\\s]+?\.(?:webp|jpg|jpeg|png|gif)(?:\?[^"'<>\\\s]*)?/gi;

    while (
        (match = storageRegex.exec(html)) !== null
    ) {
        addImage(match[0]);
    }


    /*
     * -----------------------------------------------------
     * 4. storage.waitst.com
     * -----------------------------------------------------
     */

    const waitstRegex =
        /https?:\/\/storage\.waitst\.com\/[^"'<>\\\s]+?\.(?:webp|jpg|jpeg|png|gif)(?:\?[^"'<>\\\s]*)?/gi;

    while (
        (match = waitstRegex.exec(html)) !== null
    ) {
        addImage(match[0]);
    }


    /*
     * -----------------------------------------------------
     * 5. Escaped JSON / JavaScript URLs
     * -----------------------------------------------------
     */

    const decoded = html
        .replace(/\\u002F/gi, "/")
        .replace(/\\u003A/gi, ":")
        .replace(/\\\//g, "/")
        .replace(/&quot;/gi, '"')
        .replace(/&#x2F;/gi, "/")
        .replace(/&#47;/gi, "/");


    while (
        (match = storageRegex.exec(decoded)) !== null
    ) {
        addImage(match[0]);
    }


    while (
        (match = waitstRegex.exec(decoded)) !== null
    ) {
        addImage(match[0]);
    }


    /*
     * -----------------------------------------------------
     * 6. Relative storage URLs
     * -----------------------------------------------------
     */

    const relativeStorageRegex =
        /(?:https?:)?\/\/(?:img-r1|img-r2|imgs-2)\.2xstorage\.com\/[^"'<>\\\s]+?\.(?:webp|jpg|jpeg|png|gif)(?:\?[^"'<>\\\s]*)?/gi;

    while (
        (match = relativeStorageRegex.exec(html)) !== null
    ) {
        addImage(match[0]);
    }


    return Array.from(images);
}


/* =========================================================
   SORT PAGES
========================================================= */

function sortPages(pages) {
    return pages.sort((a, b) => {

        function getNumber(url) {
            const match = url.match(
                /(?:\/|_)(\d+)\.(?:webp|jpg|jpeg|png|gif)(?:[?#].*)?$/i
            );

            return match
                ? Number(match[1])
                : Number.MAX_SAFE_INTEGER;
        }

        return getNumber(a) - getNumber(b);
    });
}


/* =========================================================
   EXTRACT MANGA LINKS
========================================================= */

function extractMangaLinks(html, title) {
    const results = [];

    const wanted = normalizeTitle(title);

    if (!wanted) {
        return results;
    }

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while (
        (match = regex.exec(html)) !== null
    ) {

        const href = cleanUrl(match[1]);

        if (!href) {
            continue;
        }

        if (
            !href.includes("/manga/")
        ) {
            continue;
        }

        /*
         * Don't treat chapter links as manga links.
         */
        if (
            /\/chapter[-_]/i.test(href)
        ) {
            continue;
        }

        const text = normalizeTitle(
            match[2]
                .replace(/<[^>]+>/g, " ")
        );

        const combined =
            normalizeTitle(
                href + " " + text
            );

        const words =
            wanted
                .split(" ")
                .filter(Boolean);

        let score = 0;

        for (const word of words) {
            if (combined.includes(word)) {
                score++;
            }
        }

        if (
            combined.includes(wanted) ||
            score >= Math.max(
                1,
                Math.ceil(words.length * 0.6)
            )
        ) {
            if (!results.includes(href)) {
                results.push(href);
            }
        }
    }

    return results;
}


/* =========================================================
   FIND CHAPTER URL
========================================================= */

function extractChapterLinks(html, chapter) {
    const results = [];

    const target =
        normalizeChapter(chapter);

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while (
        (match = regex.exec(html)) !== null
    ) {

        const href = cleanUrl(match[1]);

        if (!href) {
            continue;
        }

        const text =
            match[2]
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim();

        const combined =
            `${href} ${text}`;


        /*
         * MangaKakalot's current chapter format:
         *
         * /manga/one-piece/chapter-1191
         */
        const chapterRegex =
            new RegExp(
                `/chapter-${escapeRegex(target)}(?:[/?#]|$)`,
                "i"
            );


        /*
         * Also support text such as:
         *
         * Chapter 1191
         */
        const textRegex =
            new RegExp(
                `\\bchapter\\s*${escapeRegex(target)}(?:\\D|$)`,
                "i"
            );


        if (
            chapterRegex.test(href) ||
            textRegex.test(text) ||
            textRegex.test(combined)
        ) {

            if (!results.includes(href)) {
                results.push(href);
            }
        }
    }

    return results;
}


function escapeRegex(value) {
    return String(value)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/* =========================================================
   REQUEST CHAPTER
========================================================= */

async function requestChapter(url) {
    try {

        const response =
            await client.get(url);

        if (
            response.status !== 200
        ) {
            return null;
        }

        if (
            typeof response.data !== "string"
        ) {
            return null;
        }

        return response.data;

    } catch {
        return null;
    }
}


/* =========================================================
   GET CHAPTER
========================================================= */

async function getChapter(title, chapter) {

    if (!title) {
        throw new Error(
            "Manga title is required."
        );
    }

    if (!chapter) {
        throw new Error(
            "Chapter number is required."
        );
    }


    const chapterNumber =
        normalizeChapter(chapter);

    const slug =
        slugify(title);


    /*
     * -----------------------------------------------------
     * IMPORTANT:
     *
     * Current MangaKakalot chapter URL:
     *
     * /manga/one-piece/chapter-1191
     * -----------------------------------------------------
     */

    const directChapterUrls = [
        `${BASE_URL}/manga/${slug}/chapter-${chapterNumber}`,
        `${BASE_URL}/manga/${slug}/chapter-${chapterNumber}/`
    ];


    const tried =
        new Set();


    /*
     * -----------------------------------------------------
     * 1. DIRECT CHAPTER
     * -----------------------------------------------------
     */

    for (
        const url of directChapterUrls
    ) {

        if (tried.has(url)) {
            continue;
        }

        tried.add(url);


        const html =
            await requestChapter(url);


        if (!html) {
            continue;
        }


        const pages =
            sortPages(
                extractImages(html)
            );


        if (
            pages.length > 0
        ) {

            return {
                title: title,
                chapter: chapterNumber,
                source: "MangaKakalot",
                pages
            };
        }
    }


    /*
     * -----------------------------------------------------
     * 2. MANGA PAGE
     *
     * Current:
     * /manga/one-piece
     * -----------------------------------------------------
     */

    const mangaUrl =
        `${BASE_URL}/manga/${slug}`;


    if (!tried.has(mangaUrl)) {

        tried.add(mangaUrl);

        const html =
            await requestChapter(mangaUrl);


        if (html) {

            /*
             * Locate the exact chapter link.
             */
            const chapterLinks =
                extractChapterLinks(
                    html,
                    chapterNumber
                );


            for (
                const chapterUrl
                of chapterLinks
            ) {

                if (
                    tried.has(chapterUrl)
                ) {
                    continue;
                }

                tried.add(chapterUrl);


                const chapterHtml =
                    await requestChapter(
                        chapterUrl
                    );


                if (!chapterHtml) {
                    continue;
                }


                const pages =
                    sortPages(
                        extractImages(
                            chapterHtml
                        )
                    );


                if (
                    pages.length > 0
                ) {

                    return {
                        title: title,
                        chapter: chapterNumber,
                        source: "MangaKakalot",
                        pages
                    };
                }
            }
        }
    }


    /*
     * -----------------------------------------------------
     * 3. SEARCH
     * -----------------------------------------------------
     */

    const searchUrls = [

        `${BASE_URL}/search/${encodeURIComponent(title)}`,

        `${BASE_URL}/search?keyword=${encodeURIComponent(title)}`,

        `${BASE_URL}/search?search=${encodeURIComponent(title)}`
    ];


    for (
        const searchUrl
        of searchUrls
    ) {

        if (
            tried.has(searchUrl)
        ) {
            continue;
        }

        tried.add(searchUrl);


        const searchHtml =
            await requestChapter(
                searchUrl
            );


        if (!searchHtml) {
            continue;
        }


        const mangaLinks =
            extractMangaLinks(
                searchHtml,
                title
            );


        /*
         * Try every reasonable matching manga.
         */
        for (
            const foundMangaUrl
            of mangaLinks
        ) {

            if (
                tried.has(foundMangaUrl)
            ) {
                continue;
            }

            tried.add(foundMangaUrl);


            const mangaHtml =
                await requestChapter(
                    foundMangaUrl
                );


            if (!mangaHtml) {
                continue;
            }


            const chapterLinks =
                extractChapterLinks(
                    mangaHtml,
                    chapterNumber
                );


            /*
             * Directly try discovered chapter URL.
             */
            for (
                const chapterUrl
                of chapterLinks
            ) {

                if (
                    tried.has(chapterUrl)
                ) {
                    continue;
                }

                tried.add(chapterUrl);


                const chapterHtml =
                    await requestChapter(
                        chapterUrl
                    );


                if (!chapterHtml) {
                    continue;
                }


                const pages =
                    sortPages(
                        extractImages(
                            chapterHtml
                        )
                    );


                if (
                    pages.length > 0
                ) {

                    return {
                        title: title,
                        chapter: chapterNumber,
                        source: "MangaKakalot",
                        pages
                    };
                }
            }


            /*
             * If chapter link extraction fails,
             * try constructing it from the actual
             * manga URL.
             */
            const base =
                foundMangaUrl
                    .replace(/\/+$/, "");


            const constructedUrls = [
                `${base}/chapter-${chapterNumber}`,
                `${base}/chapter-${chapterNumber}/`
            ];


            for (
                const chapterUrl
                of constructedUrls
            ) {

                if (
                    tried.has(chapterUrl)
                ) {
                    continue;
                }

                tried.add(chapterUrl);


                const chapterHtml =
                    await requestChapter(
                        chapterUrl
                    );


                if (!chapterHtml) {
                    continue;
                }


                const pages =
                    sortPages(
                        extractImages(
                            chapterHtml
                        )
                    );


                if (
                    pages.length > 0
                ) {

                    return {
                        title: title,
                        chapter: chapterNumber,
                        source: "MangaKakalot",
                        pages
                    };
                }
            }
        }
    }


    /*
     * -----------------------------------------------------
     * NOTHING FOUND
     * -----------------------------------------------------
     */

    throw new Error(
        `No manga pages found on MangaKakalot for "${title}" chapter ${chapterNumber}.`
    );
}


/* =========================================================
   EXPORT
========================================================= */

module.exports = {
    name: "MangaKakalot",
    getChapter
};
