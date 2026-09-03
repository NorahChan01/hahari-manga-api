const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangalivre.to";

const agent = new https.Agent({
    rejectUnauthorized: false
});

const client = axios.create({
    httpsAgent: agent,
    timeout: 25000,
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
            "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",

        "Cache-Control": "no-cache",

        "Referer": BASE_URL + "/"
    },

    validateStatus: status =>
        status >= 200 && status < 400
});

function cleanText(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTitle(value) {
    return cleanText(value)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function slugify(value) {
    return normalizeTitle(value)
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function absoluteUrl(url) {
    if (!url) return null;

    let value = String(url)
        .trim()
        .replace(/&amp;/gi, "&")
        .replace(/\\u002F/g, "/")
        .replace(/\\\//g, "/");

    if (!value) return null;

    if (
        value.startsWith("data:") ||
        value.startsWith("javascript:") ||
        value.startsWith("#")
    ) {
        return null;
    }

    try {
        return new URL(value, BASE_URL).href;
    } catch {
        return null;
    }
}

async function request(url, headers = {}) {
    const response = await client.get(url, {
        headers: {
            ...headers
        }
    });

    return response.data;
}

function extractLinks(html) {
    const links = [];

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const url = absoluteUrl(match[1]);

        if (!url) continue;

        links.push({
            url,
            text: cleanText(match[2])
        });
    }

    return links;
}

function extractAttribute(html, tag, attribute) {
    const values = [];

    const regex = new RegExp(
        `<${tag}\\b[^>]*\\b${attribute}\\s*=\\s*["']([^"']+)["'][^>]*>`,
        "gi"
    );

    let match;

    while ((match = regex.exec(html))) {
        values.push(match[1]);
    }

    return values;
}

function extractTitle(html) {
    let match = html.match(
        /<h1[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1>/i
    );

    if (match) {
        const title = cleanText(match[1]);

        if (title) return title;
    }

    match = html.match(
        /<h1[^>]*class=["'][^"']*(?:post-title|entry-title|manga-title)[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i
    );

    if (match) {
        const title = cleanText(match[1]);

        if (title) return title;
    }

    match = html.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
    );

    if (match) {
        return cleanText(match[1]);
    }

    match = html.match(
        /<title[^>]*>([\s\S]*?)<\/title>/i
    );

    if (match) {
        return cleanText(match[1])
            .replace(/\s*[-|]\s*Manga Livre.*$/i, "")
            .trim();
    }

    return null;
}

function extractChapterNumber(text) {
    if (!text) return null;

    const value = cleanText(text);

    let match = value.match(
        /(?:chapter|cap(?:ítulo)?|capitulo|cap\.?|epis[oó]dio|ep\.?)\s*[-#:.]?\s*(\d+(?:[.,]\d+)?)/i
    );

    if (match) {
        return match[1].replace(",", ".");
    }

    match = value.match(
        /(?:^|\D)(\d+(?:[.,]\d+)?)(?:\D|$)/
    );

    return match
        ? match[1].replace(",", ".")
        : null;
}

function chaptersEqual(a, b) {
    if (a == null || b == null) {
        return false;
    }

    const na = Number(
        String(a).replace(",", ".")
    );

    const nb = Number(
        String(b).replace(",", ".")
    );

    if (
        Number.isFinite(na) &&
        Number.isFinite(nb)
    ) {
        return Math.abs(na - nb) < 0.0001;
    }

    return String(a).trim() ===
        String(b).trim();
}

/* -------------------------------------------------------
 * IMAGE EXTRACTION
 * ----------------------------------------------------- */

function looksLikeImageUrl(url) {
    if (!url) return false;

    const value = String(url).trim();

    if (
        value.startsWith("data:") ||
        value.startsWith("javascript:")
    ) {
        return false;
    }

    /*
     * Don't require an image extension.
     *
     * Manga readers frequently use CDN URLs such as:
     *
     * https://cdn.example.com/page/123456
     *
     * or:
     *
     * https://cdn.example.com/image?id=123
     */

    if (
        /\.(?:jpe?g|png|webp|avif|gif|bmp)(?:[?#].*)?$/i.test(
            value
        )
    ) {
        return true;
    }

    /*
     * Strong image/CDN indicators.
     */
    if (
        /(?:\/image\/|\/images\/|\/img\/|\/uploads\/|\/upload\/|\/manga\/|\/chapters?\/|\/pages?\/|\/reader\/|\/comics?\/|\/storage\/)/i.test(
            value
        )
    ) {
        return true;
    }

    if (
        /(?:image|img|page|chapter|manga|comic|reader|media|cdn|picture|pic)/i.test(
            value
        )
    ) {
        return true;
    }

    return false;
}

function isBadImageUrl(url) {
    if (!url) return true;

    const value = String(url);

    if (
        /favicon|logo|avatar|emoji|icon|sprite|banner|advert|ads?|google|facebook|twitter|instagram/i.test(
            value
        )
    ) {
        return true;
    }

    /*
     * MangaLivre thumbnails/covers are not reader pages.
     */
    if (
        /(?:\/cover(?:s)?\/|\/thumbnail(?:s)?\/|\/thumb(?:s)?\/)/i.test(
            value
        )
    ) {
        return true;
    }

    return false;
}

function addImage(images, seen, rawUrl) {
    if (!rawUrl) return;

    let url = absoluteUrl(rawUrl);

    if (!url) return;

    url = url.trim();

    /*
     * Remove HTML/JSON escaping.
     */
    url = url
        .replace(/\\u0026/g, "&")
        .replace(/\\u003D/g, "=")
        .replace(/\\u002F/g, "/")
        .replace(/\\\//g, "/");

    if (isBadImageUrl(url)) {
        return;
    }

    if (!looksLikeImageUrl(url)) {
        return;
    }

    if (seen.has(url)) {
        return;
    }

    seen.add(url);
    images.push(url);
}

/*
 * Parse srcset:
 *
 * image1.jpg 480w,
 * image2.jpg 960w
 *
 * We prefer the largest candidate.
 */
function extractSrcsetUrls(srcset) {
    if (!srcset) return [];

    const entries = String(srcset)
        .split(",")
        .map(x => x.trim())
        .filter(Boolean);

    const parsed = [];

    for (const entry of entries) {
        const parts = entry.split(/\s+/);

        if (!parts[0]) continue;

        let width = 0;

        if (parts[1]) {
            const match =
                parts[1].match(/(\d+)w/i);

            if (match) {
                width = Number(match[1]);
            }
        }

        parsed.push({
            url: parts[0],
            width
        });
    }

    parsed.sort(
        (a, b) => b.width - a.width
    );

    return parsed.map(x => x.url);
}

function extractImgTags(html) {
    const images = [];
    const seen = new Set();

    /*
     * Capture complete img tags.
     */
    const imgRegex =
        /<img\b[^>]*>/gi;

    let match;

    while ((match = imgRegex.exec(html))) {
        const tag = match[0];

        const attributes = [
            "src",
            "data-src",
            "data-lazy-src",
            "data-original",
            "data-url",
            "data-image",
            "data-img",
            "data-page",
            "data-original-src",
            "data-lazy"
        ];

        for (const attribute of attributes) {
            const regex = new RegExp(
                `\\b${attribute}\\s*=\\s*["']([^"']+)["']`,
                "i"
            );

            const found =
                tag.match(regex);

            if (found) {
                addImage(
                    images,
                    seen,
                    found[1]
                );
            }
        }

        /*
         * srcset.
         */
        const srcset =
            tag.match(
                /\bsrcset\s*=\s*["']([^"']+)["']/i
            );

        if (srcset) {
            const urls =
                extractSrcsetUrls(
                    srcset[1]
                );

            /*
             * Add largest source first.
             */
            if (urls.length) {
                addImage(
                    images,
                    seen,
                    urls[0]
                );
            }
        }
    }

    return images;
}

/*
 * Extract URLs directly from JavaScript / JSON.
 *
 * This catches readers where images are stored like:
 *
 * "url":"https://cdn.../page.webp"
 *
 * or:
 *
 * ["https://cdn.../1.webp","https://cdn.../2.webp"]
 */
function extractEmbeddedImageUrls(html) {
    const images = [];
    const seen = new Set();

    /*
     * Quoted URLs.
     */
    const urlRegex =
        /["']((?:https?:)?\/\/[^"'\\\s]+)["']/gi;

    let match;

    while ((match = urlRegex.exec(html))) {
        let raw = match[1];

        raw = raw
            .replace(/\\u0026/g, "&")
            .replace(/\\u003D/g, "=")
            .replace(/\\u002F/g, "/")
            .replace(/\\\//g, "/");

        /*
         * For embedded JSON, require a reasonably strong
         * image/CDN indication.
         */
        if (
            !looksLikeImageUrl(raw) &&
            !/\.(?:jpe?g|png|webp|avif|gif)(?:[?#].*)?$/i.test(
                raw
            )
        ) {
            continue;
        }

        addImage(
            images,
            seen,
            raw
        );
    }

    /*
     * Unquoted URLs in JS.
     */
    const bareUrlRegex =
        /(?:https?:)?\/\/[^\s"'<>\\]+/gi;

    while ((match = bareUrlRegex.exec(html))) {
        const raw = match[0]
            .replace(/[),;]+$/, "");

        if (
            !looksLikeImageUrl(raw) &&
            !/\.(?:jpe?g|png|webp|avif|gif)(?:[?#].*)?$/i.test(
                raw
            )
        ) {
            continue;
        }

        addImage(
            images,
            seen,
            raw
        );
    }

    return images;
}

/*
 * Some sites use CSS background-image for reader pages.
 */
function extractBackgroundImages(html) {
    const images = [];
    const seen = new Set();

    const regex =
        /background(?:-image)?\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi;

    let match;

    while ((match = regex.exec(html))) {
        addImage(
            images,
            seen,
            match[1]
        );
    }

    return images;
}

function extractReaderImages(html) {
    const images = [];
    const seen = new Set();

    /*
     * ---------------------------------------------------
     * 1. Actual reader containers
     * ---------------------------------------------------
     */
    const containerPatterns = [
        /<div[^>]*class=["'][^"']*reading-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,

        /<div[^>]*id=["']reading-content["'][^>]*>([\s\S]*?)<\/div>/gi,

        /<div[^>]*class=["'][^"']*reading-content-rtl[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,

        /<div[^>]*class=["'][^"']*page-break[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,

        /<div[^>]*class=["'][^"']*(?:chapter-content|chapter-reader|reader-content|manga-reader)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,

        /<main[^>]*class=["'][^"']*(?:reader|reading|chapter)[^"']*["'][^>]*>([\s\S]*?)<\/main>/gi
    ];

    for (const regex of containerPatterns) {
        let match;

        while ((match = regex.exec(html))) {
            const block = match[1];

            const found =
                extractImgTags(block);

            for (const url of found) {
                addImage(
                    images,
                    seen,
                    url
                );
            }
        }
    }

    /*
     * ---------------------------------------------------
     * 2. All img tags
     * ---------------------------------------------------
     *
     * This is important because some MangaLivre pages
     * don't expose a predictable reader container.
     */
    if (images.length === 0) {
        const found =
            extractImgTags(html);

        for (const url of found) {
            addImage(
                images,
                seen,
                url
            );
        }
    }

    /*
     * ---------------------------------------------------
     * 3. Embedded JSON / JavaScript
     * ---------------------------------------------------
     */
    if (images.length === 0) {
        const found =
            extractEmbeddedImageUrls(html);

        for (const url of found) {
            addImage(
                images,
                seen,
                url
            );
        }
    }

    /*
     * ---------------------------------------------------
     * 4. CSS background images
     * ---------------------------------------------------
     */
    if (images.length === 0) {
        const found =
            extractBackgroundImages(html);

        for (const url of found) {
            addImage(
                images,
                seen,
                url
            );
        }
    }

    /*
     * ---------------------------------------------------
     * 5. Final filtering
     * ---------------------------------------------------
     */
    const filtered = images.filter(url => {
        if (isBadImageUrl(url)) {
            return false;
        }

        return true;
    });

    return [...new Set(filtered)];
}

/* -------------------------------------------------------
 * MANGA SEARCH
 * ----------------------------------------------------- */

function scoreCandidate(candidate, requestedTitle) {
    const wanted =
        normalizeTitle(requestedTitle);

    const title =
        normalizeTitle(candidate.title);

    if (!title) return 0;

    if (title === wanted) {
        return 1000;
    }

    let score = 0;

    if (title.includes(wanted)) {
        score += 500;
    }

    if (wanted.includes(title)) {
        score += 400;
    }

    const wantedWords =
        wanted.split(" ")
            .filter(Boolean);

    const titleWords =
        new Set(
            title.split(" ")
                .filter(Boolean)
        );

    let matched = 0;

    for (const word of wantedWords) {
        if (titleWords.has(word)) {
            matched++;
        }
    }

    if (wantedWords.length) {
        score += Math.round(
            matched /
            wantedWords.length *
            300
        );
    }

    return score;
}

async function searchManga(title) {
    const query =
        String(title || "").trim();

    if (!query) {
        return null;
    }

    const searchUrls = [
        `${BASE_URL}/?s=${encodeURIComponent(query)}&post_type=wp-manga`,

        `${BASE_URL}/search/${encodeURIComponent(query)}/`,

        `${BASE_URL}/?s=${encodeURIComponent(query)}`
    ];

    const candidates = [];

    for (const searchUrl of searchUrls) {
        try {
            const html =
                await request(searchUrl);

            const links =
                extractLinks(html);

            for (const link of links) {
                let parsed;

                try {
                    parsed =
                        new URL(link.url);
                } catch {
                    continue;
                }

                if (
                    parsed.hostname !==
                    new URL(BASE_URL).hostname
                ) {
                    continue;
                }

                if (
                    !/\/manga\//i.test(
                        parsed.pathname
                    )
                ) {
                    continue;
                }

                const parts =
                    parsed.pathname
                        .split("/")
                        .filter(Boolean);

                const slug =
                    parts[parts.length - 1] ||
                    "";

                const candidateTitle =
                    link.text ||
                    slug.replace(
                        /[-_]+/g,
                        " "
                    );

                candidates.push({
                    title:
                        cleanText(
                            candidateTitle
                        ),
                    url: link.url
                });
            }

            if (candidates.length) {
                break;
            }
        } catch {
            // Try next search URL.
        }
    }

    const unique = [];
    const seen = new Set();

    for (const candidate of candidates) {
        if (seen.has(candidate.url)) {
            continue;
        }

        seen.add(candidate.url);
        unique.push(candidate);
    }

    if (unique.length) {
        unique.sort(
            (a, b) =>
                scoreCandidate(
                    b,
                    query
                ) -
                scoreCandidate(
                    a,
                    query
                )
        );

        const best =
            unique[0];

        try {
            const html =
                await request(
                    best.url
                );

            return {
                title:
                    extractTitle(html) ||
                    best.title,

                url: best.url,

                html
            };
        } catch {
            return best;
        }
    }

    /*
     * Direct slug fallback.
     */
    const slug =
        slugify(query);

    const directUrls = [
        `${BASE_URL}/manga/${slug}/`,
        `${BASE_URL}/manga/${slug}`
    ];

    for (const url of directUrls) {
        try {
            const html =
                await request(url);

            const realTitle =
                extractTitle(html);

            if (realTitle) {
                return {
                    title: realTitle,
                    url,
                    html
                };
            }
        } catch {
            // Continue.
        }
    }

    return null;
}

/* -------------------------------------------------------
 * CHAPTER FINDER
 * ----------------------------------------------------- */

async function findChapter(
    mangaUrl,
    requestedChapter,
    mangaHtml = null
) {
    const html =
        mangaHtml ||
        await request(mangaUrl);

    const links =
        extractLinks(html);

    const candidates = [];

    for (const link of links) {
        const number =
            extractChapterNumber(
                link.text
            ) ||
            extractChapterNumber(
                link.url
            );

        if (number == null) {
            continue;
        }

        const combined =
            link.url +
            " " +
            link.text;

        if (
            !/chapter|capitulo|capítulo|cap\./i.test(
                combined
            )
        ) {
            continue;
        }

        candidates.push({
            url: link.url,
            text: link.text,
            number
        });
    }

    const exact =
        candidates.find(
            candidate =>
                chaptersEqual(
                    candidate.number,
                    requestedChapter
                )
        );

    if (exact) {
        return exact;
    }

    /*
     * Direct URL fallbacks.
     */
    let slug = null;

    try {
        slug =
            new URL(mangaUrl)
                .pathname
                .split("/")
                .filter(Boolean)
                .pop();
    } catch {
        slug =
            slugify(mangaUrl);
    }

    const chapter =
        String(requestedChapter)
            .trim();

    const fallbacks = [
        `${BASE_URL}/manga/${slug}/chapter-${chapter}/`,
        `${BASE_URL}/manga/${slug}/chapter-${chapter}`,
        `${BASE_URL}/manga/${slug}/${chapter}/`,
        `${BASE_URL}/manga/${slug}/${chapter}`
    ];

    for (const url of fallbacks) {
        try {
            const chapterHtml =
                await request(
                    url,
                    {
                        Referer: mangaUrl
                    }
                );

            const pages =
                extractReaderImages(
                    chapterHtml
                );

            if (
                pages.length > 0 ||
                /reading-content|page-break|chapter-reader|reader-content/i.test(
                    chapterHtml
                )
            ) {
                return {
                    url,
                    text:
                        `Chapter ${chapter}`,
                    number: chapter
                };
            }
        } catch {
            // Continue.
        }
    }

    return null;
}

/* -------------------------------------------------------
 * PUBLIC SOURCE API
 * ----------------------------------------------------- */

async function getChapter(
    title,
    chapter
) {
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

    const manga =
        await searchManga(title);

    if (!manga) {
        throw new Error(
            `Manga not found on MangaLivre: ${title}`
        );
    }

    const chapterInfo =
        await findChapter(
            manga.url,
            chapter,
            manga.html
        );

    if (!chapterInfo) {
        throw new Error(
            `Chapter ${chapter} not found on MangaLivre.`
        );
    }

    const pages =
        extractReaderImages(
            await request(
                chapterInfo.url,
                {
                    Referer: manga.url
                }
            )
        );

    if (!pages.length) {
        throw new Error(
            "No manga pages found on MangaLivre."
        );
    }

    return {
        title: manga.title,
        chapter: String(chapter),
        source: "MangaLivre",
        pages
    };
}

module.exports = {
    name: "MangaLivre",
    getChapter
};
