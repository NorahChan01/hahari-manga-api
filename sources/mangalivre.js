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
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
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

async function request(url, extraHeaders = {}) {
    const response = await client.get(url, {
        headers: {
            ...extraHeaders
        }
    });

    return response.data;
}

function extractAttribute(html, tag, attribute) {
    const results = [];

    const regex = new RegExp(
        `<${tag}\\b[^>]*\\b${attribute}\\s*=\\s*["']([^"']+)["'][^>]*>`,
        "gi"
    );

    let match;

    while ((match = regex.exec(html))) {
        results.push(match[1]);
    }

    return results;
}

function extractLinks(html) {
    const links = [];

    const regex =
        /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

    let match;

    while ((match = regex.exec(html))) {
        const href = absoluteUrl(match[1]);

        if (!href) continue;

        const text = cleanText(match[2]);

        links.push({
            url: href,
            text
        });
    }

    return links;
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
    if (a == null || b == null) return false;

    const na = Number(String(a).replace(",", "."));
    const nb = Number(String(b).replace(",", "."));

    if (Number.isFinite(na) && Number.isFinite(nb)) {
        return Math.abs(na - nb) < 0.0001;
    }

    return String(a).trim() === String(b).trim();
}

function extractImageUrls(html) {
    const images = [];

    // Normal <img src="">
    const imgSrcs = extractAttribute(html, "img", "src");

    // Lazy-loaded images
    const lazySrcs = [
        ...extractAttribute(html, "img", "data-src"),
        ...extractAttribute(html, "img", "data-lazy-src"),
        ...extractAttribute(html, "img", "data-original"),
        ...extractAttribute(html, "img", "data-url")
    ];

    const all = [...imgSrcs, ...lazySrcs];

    for (const raw of all) {
        const url = absoluteUrl(raw);

        if (!url) continue;

        if (!/\.(?:jpe?g|png|webp|avif|gif)(?:[?#].*)?$/i.test(url)) {
            continue;
        }

        if (
            /logo|avatar|favicon|icon|banner|ads?|advertisement/i.test(url)
        ) {
            continue;
        }

        images.push(url);
    }

    return [...new Set(images)];
}

function extractReaderImages(html) {
    const images = [];

    /*
     * MangaLivre uses a customized Madara reader.
     * Prefer images inside the actual reading-content container.
     */

    const readerBlocks = [];

    const patterns = [
        /<div[^>]*class=["'][^"']*reading-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
        /<div[^>]*class=["'][^"']*reading-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
        /<div[^>]*id=["']reading-content["'][^>]*>([\s\S]*?)<\/div>/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html))) {
            readerBlocks.push(match[1]);
        }
    }

    for (const block of readerBlocks) {
        images.push(...extractImageUrls(block));
    }

    /*
     * If the reader container was not detected, fall back to all images.
     */
    if (images.length === 0) {
        images.push(...extractImageUrls(html));
    }

    return [...new Set(images)];
}

function scoreMangaCandidate(candidate, requestedTitle) {
    const requested = normalizeTitle(requestedTitle);
    const title = normalizeTitle(candidate.title);

    if (!title) return 0;

    if (title === requested) {
        return 1000;
    }

    let score = 0;

    if (title.includes(requested)) {
        score += 500;
    }

    if (requested.includes(title)) {
        score += 400;
    }

    const requestedWords = requested.split(" ").filter(Boolean);
    const titleWords = new Set(title.split(" ").filter(Boolean));

    let matched = 0;

    for (const word of requestedWords) {
        if (titleWords.has(word)) {
            matched++;
        }
    }

    if (requestedWords.length) {
        score += Math.round(
            (matched / requestedWords.length) * 300
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
                const parsed = new URL(link.url);

                if (parsed.hostname !== new URL(BASE_URL).hostname) {
                    continue;
                }

                if (!/\/manga\//i.test(parsed.pathname)) {
                    continue;
                }

                const linkTitle =
                    link.text ||
                    parsed.pathname
                        .split("/")
                        .filter(Boolean)
                        .pop()
                        .replace(/[-_]+/g, " ");

                candidates.push({
                    title: cleanText(linkTitle),
                    url: link.url
                });
            }

            if (candidates.length > 0) {
                break;
            }
        } catch {
            // Try next search method.
        }
    }

    /*
     * Deduplicate.
     */
    const unique = [];

    const seen = new Set();

    for (const candidate of candidates) {
        if (seen.has(candidate.url)) continue;

        seen.add(candidate.url);
        unique.push(candidate);
    }

    if (unique.length === 0) {
        /*
         * Direct slug fallback.
         */
        const slug = slugify(query);

        const possible = [
            `${BASE_URL}/manga/${slug}/`,
            `${BASE_URL}/manga/${slug}`
        ];

        for (const url of possible) {
            try {
                const html = await request(url);

                const realTitle = extractTitle(html);

                if (realTitle) {
                    return {
                        title: realTitle,
                        url
                    };
                }
            } catch {
                // Continue.
            }
        }

        return null;
    }

    unique.sort(
        (a, b) =>
            scoreMangaCandidate(b, query) -
            scoreMangaCandidate(a, query)
    );

    const best = unique[0];

    if (scoreMangaCandidate(best, query) <= 0) {
        return null;
    }

    /*
     * Fetch the actual manga page so the title is reliable.
     */
    try {
        const html = await request(best.url);

        const realTitle = extractTitle(html);

        return {
            title: realTitle || best.title,
            url: best.url
        };
    } catch {
        return best;
    }
}

async function findChapter(mangaUrl, requestedChapter) {
    const html = await request(mangaUrl);

    const links = extractLinks(html);

    const chapterCandidates = [];

    for (const link of links) {
        const number = extractChapterNumber(link.text);

        if (number == null) continue;

        /*
         * Only consider likely chapter URLs.
         */
        if (
            !/\/chapter[-/]/i.test(link.url) &&
            !/\/manga\//i.test(link.url)
        ) {
            continue;
        }

        chapterCandidates.push({
            url: link.url,
            text: link.text,
            number
        });
    }

    /*
     * Exact chapter first.
     */
    let match = chapterCandidates.find(candidate =>
        chaptersEqual(candidate.number, requestedChapter)
    );

    if (match) {
        return match;
    }

    /*
     * Sometimes the chapter link text is poor, but the URL contains
     * the chapter number.
     */
    for (const link of links) {
        if (
            !/chapter/i.test(link.url) &&
            !/capitulo/i.test(link.url) &&
            !/capitulo/i.test(link.text)
        ) {
            continue;
        }

        const number =
            extractChapterNumber(link.text) ||
            extractChapterNumber(link.url);

        if (chaptersEqual(number, requestedChapter)) {
            return {
                url: link.url,
                text: link.text,
                number
            };
        }
    }

    /*
     * Direct Madara-style fallbacks.
     */
    const slug = mangaUrl
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .pop();

    const chapter = String(requestedChapter).trim();

    const fallbacks = [
        `${BASE_URL}/manga/${slug}/chapter-${chapter}/`,
        `${BASE_URL}/manga/${slug}/chapter-${chapter}`,
        `${BASE_URL}/manga/${slug}/${chapter}/`,
        `${BASE_URL}/manga/${slug}/${chapter}`
    ];

    for (const url of fallbacks) {
        try {
            const chapterHtml = await request(url);

            if (
                /reading-content/i.test(chapterHtml) ||
                extractReaderImages(chapterHtml).length > 0
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

async function getChapterPages(chapterUrl) {
    const html = await request(chapterUrl, {
        Referer: chapterUrl
    });

    let pages = extractReaderImages(html);

    /*
     * Remove duplicate images while preserving page order.
     */
    pages = [...new Set(pages)];

    /*
     * Remove obvious non-page images.
     */
    pages = pages.filter(url => {
        return !(
            /logo|favicon|avatar|banner|advert/i.test(url)
        );
    });

    if (pages.length === 0) {
        throw new Error("No manga pages found on MangaLivre reader.");
    }

    return pages;
}

async function fetch(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (chapter == null || chapter === "") {
        throw new Error("Chapter number is required.");
    }

    const manga = await searchManga(title);

    if (!manga) {
        throw new Error(
            `Manga not found on MangaLivre: ${title}`
        );
    }

    const chapterInfo = await findChapter(
        manga.url,
        chapter
    );

    if (!chapterInfo) {
        throw new Error(
            `Chapter ${chapter} not found on MangaLivre.`
        );
    }

    const pages = await getChapterPages(
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

    async fetch(title, chapter) {
        return await fetch(title, chapter);
    }
};
