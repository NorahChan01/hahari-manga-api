const axios = require("axios");
const cheerio = require("cheerio");

const BASE_URL = "https://mangaball.net";

const client = axios.create({
    baseURL: BASE_URL,
    timeout: 25000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept": "*/*"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function chapterNumber(value) {
    const match = String(value || "")
        .replace(",", ".")
        .match(/(\d+(?:\.\d+)?)/);

    return match ? match[1] : null;
}

function absoluteUrl(url) {
    if (!url) return null;

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

async function createSession() {
    const response = await client.get("/");

    const $ = cheerio.load(response.data);

    const csrf =
        $('meta[name="csrf-token"]').attr("content") ||
        "";

    if (!csrf) {
        throw new Error("MangaBall CSRF token was not found.");
    }

    return {
        csrf,
        cookies: response.headers["set-cookie"] || []
    };
}

function cookieHeader(cookies) {
    return cookies
        .map(cookie => cookie.split(";")[0])
        .join("; ");
}

async function smartSearch(title, session) {
    const body = new URLSearchParams();

    body.append("search_input", title);

    const response = await client.post(
        "/api/v1/smart-search/search/",
        body.toString(),
        {
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded; charset=UTF-8",
                "X-CSRF-Token": session.csrf,
                "X-Requested-With": "XMLHttpRequest",
                "Origin": BASE_URL,
                "Referer": `${BASE_URL}/search-advanced/`,
                "Cookie": cookieHeader(session.cookies)
            }
        }
    );

    const data = response.data?.data;

    if (!data) return [];

    const manga = Array.isArray(data.manga)
        ? data.manga
        : [];

    return manga
        .map(item => ({
            title: item.title || "",
            url: absoluteUrl(item.url),
            score: scoreTitle(item.title, title)
        }))
        .filter(item => item.title && item.url)
        .sort((a, b) => b.score - a.score);
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

    return common * 10;
}

async function getTitlePage(url, session) {
    return client.get(url, {
        headers: {
            Referer: BASE_URL + "/",
            Cookie: cookieHeader(session.cookies)
        }
    });
}

async function getChapterList(titleId, session, language = null) {
    const body = new URLSearchParams();

    body.append("title_id", titleId);

    if (language) {
        body.append("lang", language);
    }

    const response = await client.post(
        "/api/v1/chapter/chapter-listing-by-title-id/",
        body.toString(),
        {
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded; charset=UTF-8",
                "X-CSRF-Token": session.csrf,
                "X-Requested-With": "XMLHttpRequest",
                "Origin": BASE_URL,
                "Referer": `${BASE_URL}/`,
                "Cookie": cookieHeader(session.cookies)
            }
        }
    );

    return response.data;
}

function findTitleId($) {
    const element = $("#showUploadChapterBtn[data-title-id]");

    if (!element.length) {
        return null;
    }

    return element.attr("data-title-id") || null;
}

function findChapter(chapters, wanted) {
    if (!Array.isArray(chapters)) return null;

    const wantedNumber = chapterNumber(wanted);

    // Exact numeric chapter match
    for (const chapter of chapters) {
        if (
            chapterNumber(chapter.number) === wantedNumber
        ) {
            return chapter;
        }
    }

    // Exact title match
    const wantedText = normalize(String(wanted));

    for (const chapter of chapters) {
        const text = normalize(
            `${chapter.number || ""} ${chapter.title || ""}`
        );

        if (text === wantedText) {
            return chapter;
        }
    }

    // Last fallback
    for (const chapter of chapters) {
        if (
            normalize(String(chapter.number)) ===
            wantedText
        ) {
            return chapter;
        }
    }

    return null;
}

function extractChapterImages(html) {
    const $ = cheerio.load(html);

    let images = [];

    // Current MangaBall stores the reader pages in
    // a JavaScript variable called chapterImages.
    $("script").each((_, script) => {
        const text = $(script).html() || "";

        if (!text.includes("chapterImages")) {
            return;
        }

        const match = text.match(
            /chapterImages\s*=\s*(\[[\s\S]*?\])\s*;/
        );

        if (!match) return;

        try {
            const parsed = JSON.parse(match[1]);

            if (Array.isArray(parsed)) {
                images.push(...parsed);
            }
        } catch {
            // Try single/double quoted URL extraction below.
            const urls = match[1].match(
                /https?:\/\/[^"'\\\s]+/g
            );

            if (urls) {
                images.push(...urls);
            }
        }
    });

    // Fallback: inspect reader images directly.
    if (!images.length) {
        $("img").each((_, img) => {
            const candidates = [
                $(img).attr("data-src"),
                $(img).attr("data-original"),
                $(img).attr("src")
            ];

            for (const value of candidates) {
                if (!value) continue;

                const url = absoluteUrl(value);

                if (
                    url &&
                    /^https?:\/\//i.test(url) &&
                    /\.(jpg|jpeg|png|webp)(\?.*)?$/i.test(url)
                ) {
                    images.push(url);
                    break;
                }
            }
        });
    }

    return [...new Set(
        images
            .map(absoluteUrl)
            .filter(Boolean)
            .filter(url =>
                !url.includes("/covers/")
            )
    )];
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

    // 1. Start session and obtain CSRF
    const session = await createSession();

    // 2. Search title
    const results = await smartSearch(title, session);

    if (!results.length) {
        throw new Error(
            `Manga "${title}" was not found on MangaBall.`
        );
    }

    const manga = results[0];

    // 3. Open title page
    const page = await getTitlePage(
        manga.url,
        session
    );

    const $ = cheerio.load(page.data);

    // 4. Extract title ID
    const titleId = findTitleId($);

    if (!titleId) {
        throw new Error(
            `MangaBall title ID was not found for "${title}".`
        );
    }

    // 5. Get all chapter data
    const chapterData = await getChapterList(
        titleId,
        session
    );

    if (!chapterData) {
        throw new Error(
            `MangaBall returned no chapter data for "${title}".`
        );
    }

    let chapters =
        Array.isArray(chapterData.ALL_CHAPTERS)
            ? chapterData.ALL_CHAPTERS
            : [];

    // If English is available, prefer it.
    const languages = Array.isArray(
        chapterData.ALL_LANGUAGES
    )
        ? chapterData.ALL_LANGUAGES
        : [];

    if (
        languages.length &&
        languages.some(
            lang =>
                String(lang).toLowerCase() === "en"
        )
    ) {
        try {
            const englishData = await getChapterList(
                titleId,
                session,
                languages.find(
                    lang =>
                        String(lang).toLowerCase() === "en"
                )
            );

            if (
                Array.isArray(
                    englishData?.ALL_CHAPTERS
                ) &&
                englishData.ALL_CHAPTERS.length
            ) {
                chapters = englishData.ALL_CHAPTERS;
            }
        } catch {
            // Keep original chapter list.
        }
    }

    const selected = findChapter(
        chapters,
        chapter
    );

    if (!selected) {
        throw new Error(
            `Chapter ${chapter} was not found for "${title}" on MangaBall.`
        );
    }

    if (!selected.url) {
        throw new Error(
            `MangaBall found chapter ${chapter}, but returned no reader URL.`
        );
    }

    // 6. Open reader
    const reader = await client.get(
        absoluteUrl(selected.url),
        {
            headers: {
                Referer: manga.url,
                Cookie: cookieHeader(session.cookies)
            }
        }
    );

    // 7. Extract actual page images
    const pages = extractChapterImages(
        reader.data
    );

    if (!pages.length) {
        throw new Error(
            `MangaBall chapter ${chapter} was found, but no real page images were extracted.`
        );
    }

    return {
        success: true,
        title: manga.title || title,
        chapter: String(chapter),
        source: "MangaBall",
        pages
    };
}

module.exports = {
    name: "MangaBall",
    getChapter
};
