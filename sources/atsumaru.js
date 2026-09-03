const axios = require("axios");

const BASE_URL = "https://atsu.moe";

const client = axios.create({
    baseURL: BASE_URL,
    timeout: 20000,
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*"
    }
});

function normalizeTitle(title) {
    return String(title || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function titleScore(a, b) {
    const x = normalizeTitle(a);
    const y = normalizeTitle(b);

    if (!x || !y) return 0;
    if (x === y) return 100;
    if (x.includes(y) || y.includes(x)) return 80;

    const aa = new Set(x.split(/\s+/));
    const bb = new Set(y.split(/\s+/));

    let common = 0;
    for (const word of aa) {
        if (bb.has(word)) common++;
    }

    return (common / Math.max(aa.size, bb.size)) * 60;
}

async function searchManga(title) {
    // Atsumaru's search index endpoint
    const queries = [
        `https://atsu.moe/collections/manga/documents/search?q=${encodeURIComponent(title)}`,
        `https://atsu.moe/api/manga/page?query=${encodeURIComponent(title)}`
    ];

    for (const url of queries) {
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
                    Accept: "application/json, text/plain, */*"
                }
            });

            const data = response.data;

            let items = [];

            if (Array.isArray(data)) {
                items = data;
            } else if (Array.isArray(data?.documents)) {
                items = data.documents;
            } else if (Array.isArray(data?.hits)) {
                items = data.hits.map(x => x.document || x);
            } else if (Array.isArray(data?.results)) {
                items = data.results;
            } else if (Array.isArray(data?.manga)) {
                items = data.manga;
            }

            if (!items.length) continue;

            const mapped = items
                .map(item => ({
                    id: item.id || item.mangaId || item._id,
                    title:
                        item.title ||
                        item.name ||
                        item.mangaTitle ||
                        item.seriesTitle ||
                        "",
                    score: titleScore(
                        item.title ||
                        item.name ||
                        item.mangaTitle ||
                        item.seriesTitle ||
                        "",
                        title
                    )
                }))
                .filter(x => x.id && x.title)
                .sort((a, b) => b.score - a.score);

            if (mapped.length) {
                return mapped[0];
            }
        } catch (_) {
            // Try next endpoint
        }
    }

    return null;
}

async function getMangaInfo(mangaId) {
    const response = await client.get("/api/manga/info", {
        params: {
            mangaId
        }
    });

    return response.data;
}

function chapterNumber(chapter) {
    const match = String(chapter)
        .replace(",", ".")
        .match(/(\d+(?:\.\d+)?)/);

    return match ? match[1] : String(chapter).trim();
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error("Manga title is required.");
    }

    if (chapter === undefined || chapter === null || chapter === "") {
        throw new Error("Chapter number is required.");
    }

    // 1. Search manga
    const manga = await searchManga(title);

    if (!manga) {
        throw new Error(`Manga "${title}" was not found on Atsumaru.`);
    }

    const mangaId = manga.id;

    // 2. Get manga/chapter information
    const info = await getMangaInfo(mangaId);

    if (!info) {
        throw new Error(`Could not load manga information for "${title}".`);
    }

    const chapters = Array.isArray(info.chapters)
        ? info.chapters
        : [];

    if (!chapters.length) {
        throw new Error(`No chapters found for "${title}".`);
    }

    const wanted = chapterNumber(chapter);

    // Try exact numeric match first
    let selected = chapters.find(c => {
        const value = chapterNumber(
            c.chapterNumber ??
            c.number ??
            c.chapter ??
            c.title ??
            ""
        );

        return value === wanted;
    });

    // Fallback: compare chapter title text
    if (!selected) {
        selected = chapters.find(c => {
            const text = String(
                c.title ??
                c.name ??
                c.chapter ??
                ""
            ).toLowerCase();

            return text === String(chapter).toLowerCase();
        });
    }

    if (!selected) {
        throw new Error(
            `Chapter ${chapter} was not found for "${title}" on Atsumaru.`
        );
    }

    const chapterId =
        selected.id ||
        selected.chapterId ||
        selected.cid;

    if (!chapterId) {
        throw new Error(
            `Atsumaru returned chapter ${chapter}, but no chapter ID was found.`
        );
    }

    // 3. Get actual reader pages
    const response = await client.get("/api/read/chapter", {
        params: {
            mangaId,
            chapterId
        }
    });

    const data = response.data;

    const pages =
        data?.readChapter?.pages ||
        data?.chapter?.pages ||
        data?.pages ||
        [];

    const imageUrls = pages
        .map(page => {
            if (typeof page === "string") return page;

            return (
                page.image ||
                page.url ||
                page.src ||
                page.imageUrl ||
                null
            );
        })
        .filter(url =>
            typeof url === "string" &&
            /^https?:\/\//i.test(url)
        );

    if (!imageUrls.length) {
        throw new Error(
            `Atsumaru chapter ${chapter} was found, but no page images were returned.`
        );
    }

    return {
        success: true,
        title:
            info.title ||
            manga.title ||
            title,
        chapter: String(chapter),
        source: "Atsumaru",
        pages: imageUrls
    };
}

module.exports = {
    name: "Atsumaru",
    getChapter
};
