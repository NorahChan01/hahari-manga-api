const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://www.mangahere.cc";
const MOBILE_URL = "https://m.mangahere.cc";

const client = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function absolute(url, base = BASE_URL) {
    try {
        return new URL(url, base).href;
    } catch {
        return null;
    }
}

function chapterNumber(text) {
    const match = String(text || "").match(
        /(?:chapter|ch\.?|episode|ep\.?)[\s._-]*(\d+(?:\.\d+)?)/i
    );

    return match ? match[1] : null;
}

function sameChapter(a, b) {
    if (!a) return false;

    return (
        String(a).trim() === String(b).trim() ||
        Number(a) === Number(b)
    );
}

/*
 * MangaHere uses a packed JavaScript reader.
 * This is a small P.A.C.K.E.R. decoder for the
 * reader script used by MangaHere.
 */
function unpackPacker(p, a, c, k, e, d) {
    function base36(num) {
        return num.toString(36);
    }

    if (!p || !a || !c || !k) {
        return "";
    }

    try {
        while (c--) {
            const key = base36(c);

            const value =
                k[c] !== undefined && k[c] !== ""
                    ? k[c]
                    : key;

            p = p.replace(
                new RegExp("\\b" + key + "\\b", "g"),
                value
            );
        }

        return p;
    } catch {
        return "";
    }
}

/*
 * More complete Dean Edwards P.A.C.K.E.R. decoder.
 */
function decodePackedScript(script) {
    const match = script.match(
        /eval\(function\(p,a,c,k,e,d\).*?\}\('([\s\S]*?)',(\d+),(\d+),'([\s\S]*?)'\.split\('\|'\)/m
    );

    if (!match) {
        return script;
    }

    const payload = match[1];
    const radix = parseInt(match[2], 10);
    let count = parseInt(match[3], 10);
    const keywords = match[4].split("|");

    function encode(num) {
        let result = "";

        do {
            result =
                (num % radix).toString(radix) + result;
            num = Math.floor(num / radix);
        } while (num > 0);

        return result;
    }

    while (count--) {
        const word =
            keywords[count] || encode(count);

        if (!word) continue;

        const token = encode(count);

        const regex = new RegExp(
            "\\b" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b",
            "g"
        );

        script = script.replace(regex, word);
    }

    return payload;
}

/*
 * Extract MangaHere reader variables.
 *
 * Current MangaHere readers commonly contain:
 *
 * pix=...
 * pvalue=...
 *
 * The official current extractor also relies on
 * these values after unpacking the reader script.
 */
function extractReaderVariables(html) {
    const decoded = decodePackedScript(html);

    let pix = null;
    let pvalue = null;

    const pixMatches = [
        decoded.match(/pix\s*=\s*["']([^"']+)["']/i),
        decoded.match(/pix\s*:\s*["']([^"']+)["']/i)
    ];

    for (const match of pixMatches) {
        if (match) {
            pix = match[1];
            break;
        }
    }

    const pvalueMatches = [
        decoded.match(/pvalue\s*=\s*["']([^"']+)["']/i),
        decoded.match(/pvalue\s*:\s*["']([^"']+)["']/i)
    ];

    for (const match of pvalueMatches) {
        if (match) {
            pvalue = match[1];
            break;
        }
    }

    return {
        pix,
        pvalue,
        decoded
    };
}

function extractDirectImages(html) {
    const $ = cheerio.load(html);
    const pages = [];

    $("img").each((_, el) => {
        const src =
            $(el).attr("data-original") ||
            $(el).attr("data-src") ||
            $(el).attr("src");

        if (!src) return;

        const url = absolute(src);

        if (!url) return;

        if (
            /\.(jpg|jpeg|png|webp)(?:\?|$)/i.test(url)
        ) {
            pages.push(url);
        }
    });

    return pages;
}

async function searchManga(title) {
    const wanted = normalize(title);

    const urls = [
        `${BASE_URL}/search?title=${encodeURIComponent(title)}`,
        `${BASE_URL}/search/?title=${encodeURIComponent(title)}`
    ];

    for (const url of urls) {
        try {
            const response = await client.get(url);

            const $ = cheerio.load(response.data);

            const results = [];

            $("a[href*='/manga/']").each((_, el) => {
                const href = $(el).attr("href");
                const text = $(el).attr("title") ||
                    $(el).text().trim();

                if (!href || !text) return;

                const name = text
                    .replace(/\s+/g, " ")
                    .trim();

                const normalized = normalize(name);

                let score = 0;

                if (normalized === wanted) {
                    score = 100;
                } else if (normalized.includes(wanted)) {
                    score = 80;
                } else if (wanted.includes(normalized)) {
                    score = 70;
                }

                results.push({
                    title: name,
                    url: absolute(href),
                    score
                });
            });

            const unique = results.filter(
                (item, index, arr) =>
                    item.url &&
                    arr.findIndex(x => x.url === item.url) === index
            );

            unique.sort((a, b) => b.score - a.score);

            if (unique.length) {
                return unique[0];
            }
        } catch (_) {}
    }

    /*
     * Fallback: MangaHere search is sometimes easier
     * to reach from the mobile site.
     */
    try {
        const response = await client.get(
            `${MOBILE_URL}/search?title=${encodeURIComponent(title)}`
        );

        const $ = cheerio.load(response.data);
        const results = [];

        $("a[href*='/manga/']").each((_, el) => {
            const href = $(el).attr("href");
            const text = $(el).attr("title") ||
                $(el).text().trim();

            if (!href || !text) return;

            const name = text.replace(/\s+/g, " ").trim();
            const normalized = normalize(name);

            let score = 0;

            if (normalized === wanted) score = 100;
            else if (normalized.includes(wanted)) score = 80;
            else if (wanted.includes(normalized)) score = 70;

            results.push({
                title: name,
                url: absolute(href, MOBILE_URL),
                score
            });
        });

        results.sort((a, b) => b.score - a.score);

        if (results.length) {
            return results[0];
        }
    } catch (_) {}

    return null;
}

async function getChapterUrl(manga, chapter) {
    const response = await client.get(manga.url);

    const $ = cheerio.load(response.data);

    let result = null;

    $("#chapterlist li a").each((_, el) => {
        if (result) return;

        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href) return;

        const number =
            chapterNumber(`${text} ${href}`);

        if (sameChapter(number, chapter)) {
            result = absolute(href, manga.url);
        }
    });

    /*
     * Current MangaHere uses #chapterlist.
     */
    if (!result) {
        $("a[href]").each((_, el) => {
            if (result) return;

            const href = $(el).attr("href");
            const text = $(el).text().trim();

            if (!href) return;

            const number =
                chapterNumber(`${text} ${href}`);

            if (sameChapter(number, chapter)) {
                result = absolute(href, manga.url);
            }
        });
    }

    return result;
}

async function getReaderPages(chapterUrl) {
    /*
     * MangaHere reader pages are traditionally loaded
     * one page at a time and use an AJAX endpoint.
     *
     * First request the chapter itself.
     */
    const response = await client.get(chapterUrl, {
        headers: {
            Referer: chapterUrl
        }
    });

    const html = response.data;

    /*
     * Some chapters expose the image directly.
     */
    const direct = extractDirectImages(html);

    if (direct.length) {
        return direct;
    }

    /*
     * MangaHere/DM5 reader uses an AJAX request.
     */
    const ajaxHeaders = {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36",
        "Referer": chapterUrl,
        "Accept": "*/*",
        "X-Requested-With": "XMLHttpRequest",
        "Accept-Language": "en-US,en;q=0.9"
    };

    /*
     * Try the chapter's own URL first.
     * MangaHere has historically exposed the packed
     * reader through the mobile reader route.
     */
    const candidates = [
        chapterUrl,
        chapterUrl.replace(
            "https://www.mangahere.cc",
            "https://m.mangahere.cc"
        )
    ];

    for (const pageUrl of candidates) {
        try {
            const page = await client.get(pageUrl, {
                headers: ajaxHeaders
            });

            const vars = extractReaderVariables(page.data);

            if (vars.pix && vars.pvalue) {
                const base =
                    vars.pix.startsWith("http")
                        ? vars.pix
                        : `https:${vars.pix}`;

                const imageUrl = `${base}${vars.pvalue}`;

                return [imageUrl];
            }
        } catch (_) {}
    }

    /*
     * Try chapter pages 1..50.
     *
     * MangaHere often has:
     *
     * /manga/title/c001/1.html
     * /manga/title/c001/2.html
     *
     * Each page can contain one packed image URL.
     */
    const baseChapter = chapterUrl.replace(/\/+$/, "");

    const pages = [];

    for (let page = 1; page <= 100; page++) {
        const candidatesForPage = [
            `${baseChapter}/${page}.html`,
            `${baseChapter}/${page}`,
            `${baseChapter}/`
        ];

        let found = false;

        for (const pageUrl of candidatesForPage) {
            try {
                const pageResponse = await client.get(
                    pageUrl,
                    {
                        headers: ajaxHeaders
                    }
                );

                const pageHtml = pageResponse.data;

                const directImages =
                    extractDirectImages(pageHtml);

                if (directImages.length) {
                    for (const image of directImages) {
                        if (!pages.includes(image)) {
                            pages.push(image);
                        }
                    }

                    found = true;
                    break;
                }

                const vars =
                    extractReaderVariables(pageHtml);

                if (vars.pix && vars.pvalue) {
                    let base =
                        vars.pix.startsWith("http")
                            ? vars.pix
                            : `https:${vars.pix}`;

                    if (!base.endsWith("/")) {
                        base += "/";
                    }

                    const image =
                        absolute(
                            vars.pvalue,
                            base
                        );

                    if (image && !pages.includes(image)) {
                        pages.push(image);
                    }

                    found = true;
                    break;
                }
            } catch (_) {}
        }

        /*
         * Once we hit a page that does not exist,
         * stop after the reader has already produced pages.
         */
        if (!found && pages.length) {
            break;
        }
    }

    return pages;
}

module.exports = {
    name: "MangaHere",

    async getChapter(title, chapter) {
        if (!title || chapter === undefined || chapter === null) {
            throw new Error(
                "Title and chapter are required."
            );
        }

        const manga = await searchManga(title);

        if (!manga) {
            throw new Error(
                `Manga "${title}" was not found on MangaHere.`
            );
        }

        const chapterUrl =
            await getChapterUrl(manga, chapter);

        if (!chapterUrl) {
            throw new Error(
                `Chapter ${chapter} was not found for "${title}" on MangaHere.`
            );
        }

        const pages =
            await getReaderPages(chapterUrl);

        const cleanPages = pages
            .map(url => absolute(url))
            .filter(Boolean)
            .filter(
                (url, index, arr) =>
                    arr.indexOf(url) === index
            );

        if (!cleanPages.length) {
            throw new Error(
                `No manga pages found on MangaHere for "${title}" chapter ${chapter}.`
            );
        }

        return {
            title: manga.title || title,
            chapter: String(chapter),
            source: "MangaHere",
            pages: cleanPages
        };
    }
};
