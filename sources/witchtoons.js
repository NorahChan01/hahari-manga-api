const axios = require("axios");
const https = require("https");

const BASE_URL = "https://witchtoons.net";

const agent = new https.Agent({
    rejectUnauthorized: false
});

const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
};

function cleanText(value) {
    return String(value || "")
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\\r/g, " ")
        .replace(/\\t/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTitle(title) {
    return cleanText(title)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function slugify(title) {
    return normalizeTitle(title)
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function absoluteUrl(url) {
    if (!url) return null;

    url = String(url)
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .trim();

    if (!url) return null;

    if (url.startsWith("//")) {
        return "https:" + url;
    }

    if (url.startsWith("/")) {
        return BASE_URL + url;
    }

    if (/^https?:\/\//i.test(url)) {
        return url;
    }

    return null;
}

async function request(url) {
    const response = await axios.get(url, {
        httpsAgent: agent,
        headers: HEADERS,
        timeout: 25000,
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
    });

    return {
        html: String(response.data || ""),
        url: response.request?.res?.responseUrl || url
    };
}

function extractLinks(html) {
    const links = [];
    const seen = new Set();

    const patterns = [
        /href\s*=\s*"([^"]+)"/gi,
        /href\s*=\s*'([^']+)'/gi,
        /\\"href\\"\s*:\s*\\"([^"]+)\\"/gi,
        /"url"\s*:\s*"([^"]+)"/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html))) {
            const url = absoluteUrl(match[1]);

            if (!url) continue;
            if (!url.startsWith(BASE_URL)) continue;

            if (!seen.has(url)) {
                seen.add(url);
                links.push(url);
            }
        }
    }

    return links;
}

function extractImages(html) {
    const images = [];
    const seen = new Set();

    const patterns = [
        /<img[^>]+src=["']([^"']+)["']/gi,
        /<img[^>]+data-src=["']([^"']+)["']/gi,
        /<img[^>]+data-lazy-src=["']([^"']+)["']/gi,
        /"src"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"]*)?)"/gi,
        /\\"src\\"\s*:\s*\\"([^"]+\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"]*)?)\\"/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html))) {
            let url = absoluteUrl(match[1]);

            if (!url) {
                url = match[1];
            }

            if (!url) continue;

            url = url.replace(/\\u0026/g, "&");

            if (
                !/\.(jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(url)
            ) {
                continue;
            }

            /*
             * Skip obvious covers/thumbnails.
             */
            if (
                /\/covers?\//i.test(url) ||
                /\/thumbnail/i.test(url) ||
                /\/thumbs?\//i.test(url)
            ) {
                continue;
            }

            if (!seen.has(url)) {
                seen.add(url);
                images.push(url);
            }
        }
    }

    return images;
}

function extractChapterNumber(value) {
    if (!value) return null;

    const text = decodeURIComponent(
        String(value)
            .replace(/\\u002F/g, "/")
            .replace(/\\u002D/g, "-")
    );

    const patterns = [
        /\/chapter\/(\d+(?:\.\d+)?)/i,
        /chapter[-_ ]?(\d+(?:\.\d+)?)/i,
        /\bch(?:apter)?\.?\s*(\d+(?:\.\d+)?)\b/i
    ];

    for (const regex of patterns) {
        const match = text.match(regex);

        if (match) {
            return String(match[1]);
        }
    }

    return null;
}

function chaptersEqual(a, b) {
    const x = parseFloat(String(a));
    const y = parseFloat(String(b));

    if (!Number.isNaN(x) && !Number.isNaN(y)) {
        return Math.abs(x - y) < 0.00001;
    }

    return String(a).trim() === String(b).trim();
}

function scoreTitle(found, wanted) {
    const a = normalizeTitle(found);
    const b = normalizeTitle(wanted);

    if (!a || !b) return 0;

    if (a === b) return 100;

    if (a.includes(b) || b.includes(a)) {
        return 70;
    }

    const aWords = new Set(a.split(" "));
    const bWords = new Set(b.split(" "));

    let common = 0;

    for (const word of bWords) {
        if (aWords.has(word)) {
            common++;
        }
    }

    return common * 10;
}

function extractSeriesCandidates(html) {
    const candidates = [];
    const seen = new Set();

    const regexes = [
        /href\s*=\s*["'](\/series\/comic\/[^"'?#]+)["']/gi,
        /\\"href\\"\s*:\s*\\"(\/series\/comic\/[^"\\?#]+)\\"/gi,
        /https:\/\/witchtoons\.net\/series\/comic\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/gi
    ];

    for (const regex of regexes) {
        let match;

        while ((match = regex.exec(html))) {
            const raw = match[1] || match[0];

            const url = absoluteUrl(
                raw
                    .replace(/\\"/g, "")
                    .replace(/\\u002F/g, "/")
            );

            if (!url) continue;

            const cleanUrl = url.split("?")[0].split("#")[0];

            /*
             * Only series/comic/<slug>
             */
            const matchSlug = cleanUrl.match(
                /^https:\/\/witchtoons\.net\/series\/comic\/([^/]+)\/?$/i
            );

            if (!matchSlug) continue;

            if (seen.has(cleanUrl)) continue;

            seen.add(cleanUrl);

            candidates.push({
                url: cleanUrl,
                slug: matchSlug[1]
            });
        }
    }

    return candidates;
}

function extractSeriesTitle(html, fallbackTitle) {
    const patterns = [
        /<h1[^>]*>([\s\S]*?)<\/h1>/i,
        /<title[^>]*>([\s\S]*?)<\/title>/i,
        /"name"\s*:\s*"([^"]+)"/i,
        /\\"name\\"\s*:\s*\\"([^"\\]+)\\"/i
    ];

    for (const regex of patterns) {
        const match = html.match(regex);

        if (!match) continue;

        let title = cleanText(
            match[1]
                .replace(/<[^>]+>/g, " ")
                .replace(/&amp;/g, "&")
        );

        title = title
            .replace(/\s*\|\s*WitchToons.*$/i, "")
            .trim();

        if (
            title &&
            title.length > 1 &&
            !/^witchtoons$/i.test(title)
        ) {
            return title;
        }
    }

    return fallbackTitle;
}

function extractChapterLinks(html) {
    const chapters = [];
    const seen = new Set();

    const patterns = [
        /href\s*=\s*["'](\/series\/comic\/[^"'?#]+\/chapter\/[^"'?#]+)["']/gi,
        /\\"href\\"\s*:\s*\\"(\/series\/comic\/[^"\\?#]+\/chapter\/[^"\\?#]+)\\"/gi,
        /https:\/\/witchtoons\.net\/series\/comic\/[^"'\\\s]+\/chapter\/[^"'\\\s]+/gi
    ];

    for (const regex of patterns) {
        let match;

        while ((match = regex.exec(html))) {
            const raw = match[1] || match[0];

            const url = absoluteUrl(
                raw
                    .replace(/\\"/g, "")
                    .replace(/\\u002F/g, "/")
            );

            if (!url) continue;

            const cleanUrl = url.split("?")[0].split("#")[0];

            const chapter = extractChapterNumber(cleanUrl);

            if (chapter === null) continue;

            if (seen.has(cleanUrl)) continue;

            seen.add(cleanUrl);

            chapters.push({
                url: cleanUrl,
                chapter
            });
        }
    }

    return chapters;
}

/*
 * WitchToons puts useful series/chapter information in
 * Next.js React Server Component payloads.

 * This function extracts escaped JSON-like strings from
 * that payload and turns them back into normal HTML/text.
 */
function decodeRscPayload(html) {
    let result = html;

    const replacements = [
        [/\\u002F/g, "/"],
        [/\\u002D/g, "-"],
        [/\\u003C/g, "<"],
        [/\\u003E/g, ">"],
        [/\\u0026/g, "&"],
        [/\\u003F/g, "?"],
        [/\\u003D/g, "="],
        [/\\u0025/g, "%"],
        [/\\"/g, '"'],
        [/\\\\/g, "\\"]
    ];

    for (const [regex, replacement] of replacements) {
        result = result.replace(regex, replacement);
    }

    return result;
}

async function searchManga(title) {
    const wantedTitle = cleanText(title);

    if (!wantedTitle) {
        return null;
    }

    const query = encodeURIComponent(wantedTitle);

    const searchUrls = [
        `${BASE_URL}/series?search=${query}`,
        `${BASE_URL}/series?keyword=${query}`,
        `${BASE_URL}/search?keyword=${query}`,
        `${BASE_URL}/search?q=${query}`
    ];

    let best = null;
    let bestScore = 0;

    for (const searchUrl of searchUrls) {
        try {
            const { html } = await request(searchUrl);

            const decoded = decodeRscPayload(html);

            const candidates = extractSeriesCandidates(
                html + "\n" + decoded
            );

            for (const candidate of candidates) {
                let candidateTitle = candidate.slug
                    .replace(/[-_]+/g, " ")
                    .trim();

                /*
                 * Open the series page to get the real title.
                 */
                try {
                    const page = await request(candidate.url);

                    candidateTitle = extractSeriesTitle(
                        page.html,
                        candidateTitle
                    );
                } catch (_) {}

                const score = scoreTitle(
                    candidateTitle,
                    wantedTitle
                );

                if (score > bestScore) {
                    bestScore = score;

                    best = {
                        url: candidate.url,
                        title: candidateTitle
                    };
                }
            }

            /*
             * Exact match is good enough.
             */
            if (bestScore >= 100) {
                return best;
            }
        } catch (_) {}
    }

    /*
     * Direct slug fallback.
     */
    const fallbackSlug = slugify(wantedTitle);

    const fallbackUrls = [
        `${BASE_URL}/series/comic/${fallbackSlug}`,
        `${BASE_URL}/series/comic/${encodeURIComponent(fallbackSlug)}`
    ];

    for (const url of fallbackUrls) {
        try {
            const page = await request(url);

            if (
                page.html &&
                page.html.length > 1000 &&
                !/404|not found/i.test(page.html)
            ) {
                const realTitle = extractSeriesTitle(
                    page.html,
                    wantedTitle
                );

                return {
                    url,
                    title: realTitle || wantedTitle
                };
            }
        } catch (_) {}
    }

    return best;
}

async function findChapterFromSeriesPage(
    seriesHtml,
    seriesUrl,
    wantedChapter
) {
    const decoded = decodeRscPayload(seriesHtml);

    const combined = seriesHtml + "\n" + decoded;

    const chapters = extractChapterLinks(combined);

    /*
     * First: exact requested chapter.
     */
    for (const item of chapters) {
        if (chaptersEqual(item.chapter, wantedChapter)) {
            return item.url;
        }
    }

    /*
     * Sometimes the requested chapter is present as
     * escaped RSC data but not as a normal href.
     */
    const escapedChapterRegexes = [
        new RegExp(
            `/series/comic/[^"\\\\]+/chapter/${String(wantedChapter).replace(".", "\\.")}`,
            "gi"
        ),
        new RegExp(
            `chapter[-_]${String(wantedChapter).replace(".", "\\.")}`,
            "gi"
        )
    ];

    for (const regex of escapedChapterRegexes) {
        const match = combined.match(regex);

        if (!match) continue;

        let path = match[0]
            .replace(/\\u002F/g, "/")
            .replace(/\\/g, "");

        if (!path.startsWith("/")) {
            path = "/" + path;
        }

        const url = absoluteUrl(path);

        if (url) {
            return url;
        }
    }

    /*
     * Predictable fallback.
     */
    const slugMatch = seriesUrl.match(
        /\/series\/comic\/([^/]+)\/?$/i
    );

    if (!slugMatch) {
        return null;
    }

    const slug = slugMatch[1];

    const fallbackUrls = [
        `${BASE_URL}/series/comic/${slug}/chapter/${wantedChapter}`
    ];

    for (const url of fallbackUrls) {
        try {
            const result = await request(url);

            if (
                result.html &&
                result.html.length > 1000 &&
                !/404|not found/i.test(result.html)
            ) {
                return url;
            }
        } catch (_) {}
    }

    return null;
}

function extractReaderImages(html) {
    const decoded = decodeRscPayload(html);

    const combined = html + "\n" + decoded;

    let images = extractImages(combined);

    /*
     * Additional extraction for Next.js image payloads.
     */
    const extraPatterns = [
        /"imageUrl"\s*:\s*"([^"]+)"/gi,
        /"image"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp|avif)[^"]*)"/gi,
        /\\"imageUrl\\"\s*:\s*\\"([^"\\]+)\\"/gi,
        /\\"image\\"\s*:\s*\\"([^"\\]+\.(?:jpg|jpeg|png|webp|avif)[^"\\]*)\\"/gi
    ];

    const seen = new Set(images);

    for (const regex of extraPatterns) {
        let match;

        while ((match = regex.exec(combined))) {
            let url = match[1];

            url = absoluteUrl(url) || url;

            if (!url) continue;

            url = url
                .replace(/\\u0026/g, "&")
                .replace(/\\u002F/g, "/")
                .replace(/\\"/g, "");

            if (
                !/\.(jpg|jpeg|png|webp|avif)(?:[?#].*)?$/i.test(
                    url
                )
            ) {
                continue;
            }

            if (
                /\/covers?\//i.test(url) ||
                /\/thumbnail/i.test(url) ||
                /\/thumbs?\//i.test(url)
            ) {
                continue;
            }

            if (!seen.has(url)) {
                seen.add(url);
                images.push(url);
            }
        }
    }

    /*
     * Remove duplicate URLs.
     */
    images = [...new Set(images)];

    /*
     * Keep actual reader pages only.
     */
    images = images.filter(url => {
        const lower = url.toLowerCase();

        if (
            lower.includes("/cover/") ||
            lower.includes("/covers/") ||
            lower.includes("/thumbnail") ||
            lower.includes("/thumb/")
        ) {
            return false;
        }

        return true;
    });

    return images;
}

async function getChapter(title, chapter) {
    const wantedTitle = cleanText(title);
    const wantedChapter = cleanText(chapter);

    if (!wantedTitle || !wantedChapter) {
        throw new Error("Title and chapter are required.");
    }

    /*
     * 1. Find the series.
     */
    const manga = await searchManga(wantedTitle);

    if (!manga) {
        throw new Error(
            `Manga not found on WitchToons: ${wantedTitle}`
        );
    }

    /*
     * 2. Open the series page.
     */
    const seriesPage = await request(manga.url);

    /*
     * 3. Find requested chapter.
     */
    const chapterUrl = await findChapterFromSeriesPage(
        seriesPage.html,
        manga.url,
        wantedChapter
    );

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${wantedChapter} not found on WitchToons.`
        );
    }

    /*
     * 4. Open chapter reader.
     */
    const chapterPage = await request(chapterUrl);

    /*
     * 5. Extract reader pages.
     */
    const pages = extractReaderImages(
        chapterPage.html
    );

    if (!pages.length) {
        throw new Error(
            `No reader pages found for ${wantedTitle} chapter ${wantedChapter}.`
        );
    }

    /*
     * Safety against accidentally returning tiny
     * thumbnail/cover-only responses.
     */
    if (pages.length === 1) {
        const only = pages[0];

        if (
            /cover|thumbnail|thumb/i.test(only)
        ) {
            throw new Error(
                "WitchToons returned only a cover/thumbnail image."
            );
        }
    }

    return {
        title: manga.title || wantedTitle,
        chapter: wantedChapter,
        source: "WitchToons",
        pages
    };
}

module.exports = {
    name: "WitchToons",

    async getChapter(title, chapter) {
        return await getChapter(title, chapter);
    }
};
