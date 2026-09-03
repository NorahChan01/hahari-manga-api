const axios = require("axios");
const https = require("https");

const BASE_URL = "https://mangalivre.to";

const agent = new https.Agent({
    rejectUnauthorized: false
});

const client = axios.create({
    httpsAgent: agent,
    timeout: 20000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9," +
            "image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Referer": BASE_URL + "/"
    },
    validateStatus: status => status >= 200 && status < 400
});

function cleanText(value) {
    return String(value || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
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

    url = String(url).trim();

    if (
        url.startsWith("data:") ||
        url.startsWith("javascript:") ||
        url.startsWith("#")
    ) {
        return null;
    }

    try {
        return new URL(url, BASE_URL).href;
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

        if (title) {
            return title;
        }
    }

    match = html.match(
        /<h1[^>]*class=["'][^"']*(?:post-title|entry-title|manga-title)[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i
    );

    if (match) {
        const title = cleanText(match[1]);

        if (title) {
            return title;
        }
    }

    match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

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
        /(?:chapter|cap(?:ítulo)?|capitulo|cap\.?|epis[oó]dio|ep\.?)\s*[-#:.]?\s*(\d+(?:\.\d+)?)/i
    );

    if (match) {
        return match[1];
    }

    match = value.match(/\b(\d+(?:\.\d+)?)\b/);

    return match ? match[1] : null;
}

function chaptersEqual(a, b) {
    if (a == null || b == null) {
        return false;
    }

    const na = Number(String(a).replace(",", "."));
    const nb = Number(String(b).replace(",", "."));

    if (Number.isFinite(na) && Number.isFinite(nb)) {
        return Math.abs(na - nb) < 0.0001;
    }

    return String(a).trim() === String(b).trim();
}

function extractImageUrls(html) {
    const images = [];

    const attributes = [
        "src",
        "data-src",
        "data-lazy-src",
        "data-original",
        "data-url"
    ];

    for (const attribute of attributes) {
        const values = extractAttribute(
            html,
            "img",
            attribute
        );

        for (const value of values) {
            const url = absoluteUrl(value);

            if (!url) continue;

            /*
             * MangaLivre may use query strings after the image
             * extension, so don't require the extension to be
             * the absolute end of the URL.
             */
            if (
                !/\.(?:jpe?g|png|webp|avif|gif)(?:[?#].*)?$/i.test(
                    url
                )
            ) {
                continue;
            }

            if (
                /logo|avatar|favicon|icon|banner|advertisement|ads?/i.test(
                    url
                )
            ) {
                continue;
            }

            images.push(url);
        }
    }

    return [...new Set(images)];
}

function extractReaderImages(html) {
    const images = [];

    /*
     * Try the actual Madara reader container first.
     */
    const containerPatterns = [
        /<div[^>]*class=["'][^"']*reading-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
        /<div[^>]*id=["']reading-content["'][^>]*>([\s\S]*?)<\/div>/gi,
        /<div[^>]*class=["'][^"']*page-break[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
    ];

    for (const regex of containerPatterns) {
        let match;

        while ((match = regex.exec(html))) {
            images.push(
                ...extractImageUrls(match[1])
            );
        }
    }

    /*
     * Fallback: all images on the chapter page.
     */
    if (images.length === 0) {
        images.push(
            ...extractImageUrls(html)
        );
    }

    return [...new Set(images)];
}

function scoreCandidate(candidate, requestedTitle) {
    const wanted = normalizeTitle(requestedTitle);
    const title = normalizeTitle(candidate.title);

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

    const wantedWords = wanted
        .split(" ")
        .filter(Boolean);

    const titleWords = new Set(
        title.split(" ").filter(Boolean)
    );

    let matched = 0;

    for (const word of wantedWords) {
        if (titleWords.has(word)) {
            matched++;
        }
    }

    if (wantedWords.length > 0) {
        score += Math.round(
            (matched / wantedWords.length) * 300
        );
    }

    return score;
}

async function searchManga(title) {
    const query = String(title || "").trim();

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
            const html = await request(searchUrl);

            const links = extractLinks(html);

            for (const link of links) {
                let parsed;

                try {
                    parsed = new URL(link.url);
                } catch {
                    continue;
                }

                if (
                    parsed.hostname !==
                    new URL(BASE_URL).hostname
                ) {
                    continue;
                }

                if (!/\/manga\//i.test(parsed.pathname)) {
                    continue;
                }

                const parts = parsed.pathname
                    .split("/")
                    .filter(Boolean);

                const slug =
                    parts[parts.length - 1] || "";

                const candidateTitle =
                    link.text ||
                    slug.replace(/[-_]+/g, " ");

                candidates.push({
                    title: cleanText(candidateTitle),
                    url: link.url
                });
            }

            if (candidates.length > 0) {
                break;
            }
        } catch {
            // Try the next search method.
        }
    }

    /*
     * Remove duplicates.
     */
    const unique = [];
    const seen = new Set();

    for (const candidate of candidates) {
        if (seen.has(candidate.url)) {
            continue;
        }

        seen.add(candidate.url);
        unique.push(candidate);
    }

    if (unique.length > 0) {
        unique.sort(
            (a, b) =>
                scoreCandidate(b, query) -
                scoreCandidate(a, query)
        );

        const best = unique[0];

        try {
            const html = await request(best.url);

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
    const slug = slugify(query);

    const directUrls = [
        `${BASE_URL}/manga/${slug}/`,
        `${BASE_URL}/manga/${slug}`
    ];

    for (const url of directUrls) {
        try {
            const html = await request(url);

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

async function findChapter(
    mangaUrl,
    requestedChapter,
    mangaHtml = null
) {
    const html =
        mangaHtml ||
        await request(mangaUrl);

    const links = extractLinks(html);

    const candidates = [];

    for (const link of links) {
        const number =
            extractChapterNumber(link.text) ||
            extractChapterNumber(link.url);

        if (number == null) {
            continue;
        }

        /*
         * Chapter URLs normally contain one of these.
         */
        if (
            !/chapter|capitulo|capitulo/i.test(
                link.url + " " + link.text
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

    /*
     * Exact match.
     */
    const exact = candidates.find(
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
     * Direct URL fallback.
     */
    let slug;

    try {
        slug = new URL(mangaUrl)
            .pathname
            .split("/")
            .filter(Boolean)
            .pop();
    } catch {
        slug = slugify(mangaUrl);
    }

    const chapter =
        String(requestedChapter).trim();

    const fallbacks = [
        `${BASE_URL}/manga/${slug}/chapter-${chapter}/`,
        `${BASE_URL}/manga/${slug}/chapter-${chapter}`,
        `${BASE_URL}/manga/${slug}/${chapter}/`,
        `${BASE_URL}/manga/${slug}/${chapter}`
    ];

    for (const url of fallbacks) {
        try {
            const chapterHtml =
                await request(url, {
                    Referer: mangaUrl
                });

            const pages =
                extractReaderImages(chapterHtml);

            if (
                pages.length > 0 ||
                /reading-content|page-break/i.test(
                    chapterHtml
                )
            ) {
                return {
                    url,
                    text: `Chapter ${chapter}`,
                    number: chapter
                };
            }
        } catch {
            // Continue.
        }
    }

    return null;
}

async function getPages(chapterUrl) {
    const html = await request(
        chapterUrl,
        {
            Referer: chapterUrl
        }
    );

    let pages =
        extractReaderImages(html);

    pages = [...new Set(pages)];

    pages = pages.filter(url => {
        if (
            /logo|favicon|avatar|banner|advert|icon/i.test(
                url
            )
        ) {
            return false;
        }

        return true;
    });

    if (pages.length === 0) {
        throw new Error(
            "No manga pages found on MangaLivre."
        );
    }

    return pages;
}

/*
 * IMPORTANT:
 * Your source manager expects getChapter().
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
        await getPages(
            chapterInfo.url
        );

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
