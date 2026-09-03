const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://flamecomics.xyz";
const CDN = "https://cdn.flamecomics.xyz/uploads/images/series";

const client = axios.create({
    timeout: 25000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/['’]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function scoreTitle(found, wanted) {
    const a = normalize(found);
    const b = normalize(wanted);

    if (!a || !b) return 0;
    if (a === b) return 1000;
    if (a.includes(b)) return 800;
    if (b.includes(a)) return 700;

    const aa = new Set(a.split(/\s+/));
    const bb = new Set(b.split(/\s+/));

    let common = 0;

    for (const word of aa) {
        if (bb.has(word)) common++;
    }

    return common * 20;
}

function getNextData(html) {
    const $ = cheerio.load(html);
    const raw = $("#__NEXT_DATA__").html();

    if (!raw) {
        throw new Error(
            "Flame Comics __NEXT_DATA__ was not found."
        );
    }

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error(
            "Flame Comics returned invalid __NEXT_DATA__."
        );
    }
}

async function getBrowsePage(page = 1) {
    const url =
        page === 1
            ? `${BASE_URL}/browse`
            : `${BASE_URL}/browse?page=${page}`;

    const response = await client.get(url);

    return response.data;
}

async function searchManga(title) {
    const wanted = normalize(title);
    const matches = [];

    // Flame Comics does not provide a conventional search API.
    // Search the site's catalog pages.
    for (let page = 1; page <= 5; page++) {
        let html;

        try {
            html = await getBrowsePage(page);
        } catch (_) {
            break;
        }

        const $ = cheerio.load(html);

        $("a[href*='/series/']").each((_, el) => {
            const href = $(el).attr("href");
            const text = $(el).text().trim();

            if (!href || !text) return;

            const url = new URL(href, BASE_URL).href;

            // Ignore chapter links and duplicate entries.
            if (!url.includes("/series/")) return;

            const score = scoreTitle(text, title);

            if (score > 0) {
                if (
                    !matches.some(
                        item => item.url === url
                    )
                ) {
                    matches.push({
                        title: text,
                        url,
                        score
                    });
                }
            }
        });

        // If we have an exact match, stop immediately.
        if (
            matches.some(
                item => normalize(item.title) === wanted
            )
        ) {
            break;
        }
    }

    matches.sort((a, b) => b.score - a.score);

    return matches[0] || null;
}

function getChapterNumber(value) {
    const match = String(value || "")
        .replace(",", ".")
        .match(/(\d+(?:\.\d+)?)/);

    return match ? match[1] : null;
}

function findChapterFromProps(pageProps, wanted) {
    const wantedNumber = getChapterNumber(wanted);

    const lists = [
        pageProps?.chapters,
        pageProps?.chapterList,
        pageProps?.series?.chapters
    ];

    for (const list of lists) {
        if (!Array.isArray(list)) continue;

        for (const chapter of list) {
            const number = getChapterNumber(
                chapter?.chapter ??
                chapter?.number ??
                chapter?.name ??
                chapter?.title
            );

            if (number === wantedNumber) {
                return chapter;
            }
        }
    }

    return null;
}

async function getSeriesData(url) {
    const response = await client.get(url);

    const json = getNextData(response.data);

    return {
        html: response.data,
        json
    };
}

function extractChapterLinks(html, wanted) {
    const $ = cheerio.load(html);
    const wantedNumber = getChapterNumber(wanted);

    const links = [];

    $("a").each((_, el) => {
        const href = $(el).attr("href");
        const text = $(el).text().trim();

        if (!href) return;

        const fullUrl = new URL(href, BASE_URL).href;

        if (
            !fullUrl.includes("/series/") ||
            !fullUrl.includes("/chapter/")
        ) {
            return;
        }

        const number =
            getChapterNumber(text) ||
            getChapterNumber(fullUrl);

        if (number === wantedNumber) {
            links.push(fullUrl);
        }
    });

    return [...new Set(links)];
}

function buildPages(chapter) {
    if (!chapter) return [];

    const {
        series_id,
        token,
        images,
        release_date
    } = chapter;

    if (
        !series_id ||
        !token ||
        !images ||
        typeof images !== "object"
    ) {
        return [];
    }

    const entries = Object.entries(images);

    // IMPORTANT:
    // Object keys are page indexes as strings.
    // Sort numerically so page 10 doesn't appear
    // between page 1 and page 2.
    entries.sort((a, b) => {
        const na = Number(a[0]);
        const nb = Number(b[0]);

        if (
            Number.isFinite(na) &&
            Number.isFinite(nb)
        ) {
            return na - nb;
        }

        return a[0].localeCompare(b[0]);
    });

    return entries
        .map(([_, image]) => {
            if (!image?.name) return null;

            let url =
                `${CDN}/${series_id}/${token}/${image.name}`;

            if (release_date) {
                url += `?${encodeURIComponent(release_date)}`;
            }

            return url;
        })
        .filter(Boolean);
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (
        chapter === undefined ||
        chapter === null ||
        String(chapter).trim() === ""
    ) {
        throw new Error("Chapter number is required.");
    }

    // 1. Find the actual series.
    const manga = await searchManga(title);

    if (!manga) {
        throw new Error(
            `Manga "${title}" was not found on Flame Comics.`
        );
    }

    // 2. Open the series page.
    const series = await getSeriesData(manga.url);

    const pageProps =
        series.json?.props?.pageProps || {};

    // 3. Try chapter data already embedded in
    // the series __NEXT_DATA__.
    let selectedChapter =
        findChapterFromProps(
            pageProps,
            chapter
        );

    // 4. Find the actual chapter URL if necessary.
    let chapterUrl = null;

    if (selectedChapter) {
        chapterUrl =
            selectedChapter.url ||
            selectedChapter.href ||
            selectedChapter.link ||
            null;

        if (chapterUrl) {
            chapterUrl =
                new URL(
                    chapterUrl,
                    BASE_URL
                ).href;
        }
    }

    // 5. Fallback to chapter links in HTML.
    if (!chapterUrl) {
        const chapterLinks =
            extractChapterLinks(
                series.html,
                chapter
            );

        chapterUrl = chapterLinks[0] || null;
    }

    if (!chapterUrl) {
        throw new Error(
            `Chapter ${chapter} was not found for "${title}" on Flame Comics.`
        );
    }

    // 6. Open actual reader page.
    const readerResponse =
        await client.get(chapterUrl, {
            headers: {
                Referer: manga.url
            }
        });

    const readerJson =
        getNextData(readerResponse.data);

    const readerProps =
        readerJson?.props?.pageProps || {};

    // The current reader stores the chapter object here.
    let readerChapter =
        readerProps.chapter ||
        selectedChapter;

    // Some builds expose it under chapters.
    if (
        !readerChapter &&
        Array.isArray(readerProps.chapters)
    ) {
        readerChapter =
            findChapterFromProps(
                readerProps,
                chapter
            );
    }

    const pages =
        buildPages(readerChapter);

    if (!pages.length) {
        throw new Error(
            `Flame Comics chapter ${chapter} was found, but no page images were extracted.`
        );
    }

    return {
        success: true,
        title:
            readerChapter?.title ||
            manga.title ||
            title,
        chapter: String(chapter),
        source: "Flame Comics",
        pages
    };
}

module.exports = {
    name: "Flame Comics",
    getChapter
};
