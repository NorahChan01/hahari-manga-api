const axios = require("axios");

const API = "https://api.mangadex.org";

const client = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    headers: {
        "User-Agent": "HahariBot/1.0",
        "Accept": "application/json"
    }
});

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’'`]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function getAllTitles(manga) {
    const attributes = manga.attributes || {};

    const titles = [];

    // Main titles
    for (const value of Object.values(attributes.title || {})) {
        if (value) titles.push(value);
    }

    // Alternative titles
    for (const alt of attributes.altTitles || []) {
        for (const value of Object.values(alt || {})) {
            if (value) titles.push(value);
        }
    }

    return [...new Set(titles)];
}

function scoreManga(manga, query) {
    const wanted = normalize(query);

    if (!wanted) return 0;

    const titles = getAllTitles(manga);

    let best = 0;

    for (const rawTitle of titles) {
        const title = normalize(rawTitle);

        if (!title) continue;

        // Exact match
        if (title === wanted) {
            best = Math.max(best, 1000);
            continue;
        }

        // Exact substring
        if (title.includes(wanted)) {
            best = Math.max(best, 850);
        }

        if (wanted.includes(title)) {
            best = Math.max(best, 800);
        }

        const wantedWords =
            wanted
                .split(" ")
                .filter(word => word.length >= 2);

        const titleWords =
            new Set(
                title
                    .split(" ")
                    .filter(word => word.length >= 2)
            );

        let common = 0;

        for (const word of wantedWords) {
            if (titleWords.has(word)) {
                common++;
            }
        }

        if (wantedWords.length) {

            const ratio =
                common / wantedWords.length;

            if (ratio === 1) {
                best = Math.max(best, 750);
            } else if (ratio >= 0.75) {
                best = Math.max(best, 650);
            } else if (ratio >= 0.5) {
                best = Math.max(best, 500);
            } else if (common > 0) {
                best = Math.max(
                    best,
                    common * 80
                );
            }
        }
    }

    return best;
}

function getDisplayTitle(manga, fallback) {
    const titleObject =
        manga.attributes?.title || {};

    return (
        titleObject.en ||
        titleObject["ja-ro"] ||
        Object.values(titleObject)[0] ||
        fallback
    );
}

async function searchManga(mangaName) {

    let response;

    try {

        response =
            await client.get(
                `${API}/manga`,
                {
                    params: {
                        title: mangaName,
                        limit: 10,

                        "contentRating[]": [
                            "safe",
                            "suggestive",
                            "erotica"
                        ]
                    }
                }
            );

    } catch (error) {

        if (error.response) {
            throw new Error(
                `MangaDex search returned HTTP ${error.response.status}.`
            );
        }

        throw new Error(
            `MangaDex search failed: ${error.message}`
        );
    }

    const mangas =
        response.data?.data || [];

    if (!mangas.length) {
        throw new Error(
            `No manga found for "${mangaName}".`
        );
    }

    const ranked =
        mangas
            .map(manga => ({
                manga,
                score:
                    scoreManga(
                        manga,
                        mangaName
                    )
            }))
            .sort(
                (a, b) =>
                    b.score - a.score
            );

    const best =
        ranked[0];

    if (!best?.manga) {
        throw new Error(
            `MangaDex could not select a manga for "${mangaName}".`
        );
    }

    console.log(
        `[MangaDex] Search: "${mangaName}"`
    );

    console.log(
        `[MangaDex] Selected: "${getDisplayTitle(
            best.manga,
            mangaName
        )}" score=${best.score}`
    );

    return best.manga;
}

async function getChapters(mangaID) {

    const chapters = [];

    let offset = 0;

    while (true) {

        let response;

        try {

            response =
                await client.get(
                    `${API}/chapter`,
                    {
                        params: {
                            manga: mangaID,

                            translatedLanguage: [
                                "en"
                            ],

                            "contentRating[]": [
                                "safe",
                                "suggestive",
                                "erotica"
                            ],

                            limit: 100,
                            offset,

                            "order[chapter]":
                                "asc"
                        }
                    }
                );

        } catch (error) {

            if (error.response) {
                throw new Error(
                    `MangaDex chapter request returned HTTP ${error.response.status}.`
                );
            }

            throw new Error(
                `MangaDex chapter request failed: ${error.message}`
            );
        }

        const data =
            response.data?.data || [];

        chapters.push(...data);

        const total =
            Number(
                response.data?.total || 0
            );

        if (
            data.length === 0 ||
            chapters.length >= total
        ) {
            break;
        }

        offset += data.length;

        if (offset >= 5000) {
            break;
        }
    }

    return chapters;
}

function chapterNumberMatches(
    chapter,
    wanted
) {

    const value =
        chapter.attributes?.chapter;

    if (
        value === null ||
        value === undefined
    ) {
        return false;
    }

    const a =
        String(value).trim();

    const b =
        String(wanted).trim();

    if (a === b) {
        return true;
    }

    const numberA =
        Number(a);

    const numberB =
        Number(b);

    return (
        Number.isFinite(numberA) &&
        Number.isFinite(numberB) &&
        numberA === numberB
    );
}

async function getAtHomePages(chapterID) {

    try {

        const response =
            await client.get(
                `${API}/at-home/server/${chapterID}`
            );

        const data =
            response.data;

        if (
            !data ||
            data.result !== "ok"
        ) {
            return null;
        }

        const baseUrl =
            data.baseUrl;

        const chapter =
            data.chapter || {};

        const hash =
            chapter.hash;

        const files =
            Array.isArray(chapter.data)
                ? chapter.data
                : [];

        if (
            !baseUrl ||
            !hash ||
            !files.length
        ) {
            return null;
        }

        const pages =
            files
                .map(file => {

                    if (!file) {
                        return null;
                    }

                    return (
                        `${baseUrl}/data/` +
                        `${hash}/${file}`
                    );
                })
                .filter(Boolean);

        if (!pages.length) {
            return null;
        }

        return pages;

    } catch (error) {

        // A 404 here means this chapter exists
        // in the chapter database but has no
        // usable MangaDex@Home reader server.

        if (
            error.response?.status === 404
        ) {
            console.log(
                `[MangaDex] At-Home unavailable for ${chapterID}`
            );

            return null;
        }

        console.log(
            `[MangaDex] At-Home failed for ${chapterID}: ${error.message}`
        );

        return null;
    }
}

function sortChaptersForAttempt(
    chapters,
    wanted
) {

    const matching =
        chapters.filter(
            chapter =>
                chapterNumberMatches(
                    chapter,
                    wanted
                )
        );

    // Prefer chapters that are not marked unavailable.
    matching.sort((a, b) => {

        const unavailableA =
            Boolean(
                a.attributes?.isUnavailable
            );

        const unavailableB =
            Boolean(
                b.attributes?.isUnavailable
            );

        if (
            unavailableA !==
            unavailableB
        ) {
            return unavailableA ? 1 : -1;
        }

        // Prefer chapters with pages
        // according to MangaDex metadata.
        const pagesA =
            Number(
                a.attributes?.pages || 0
            );

        const pagesB =
            Number(
                b.attributes?.pages || 0
            );

        return pagesB - pagesA;
    });

    return matching;
}

module.exports = {

    name: "MangaDex",

    async getChapter(
        mangaName,
        chapterNumber
    ) {

        if (
            !mangaName ||
            chapterNumber === undefined ||
            chapterNumber === null
        ) {
            throw new Error(
                "Manga title and chapter number are required."
            );
        }

        console.log(
            `[MangaDex] Searching "${mangaName}" chapter ${chapterNumber}`
        );

        // ============================================
        // 1. SEARCH MANGA
        // ============================================

        const manga =
            await searchManga(
                mangaName
            );

        const mangaID =
            manga.id;

        const title =
            getDisplayTitle(
                manga,
                mangaName
            );

        // ============================================
        // 2. GET ALL CHAPTERS
        // ============================================

        const chapters =
            await getChapters(
                mangaID
            );

        if (!chapters.length) {
            throw new Error(
                `No English chapters found for "${title}" on MangaDex.`
            );
        }

        // ============================================
        // 3. FIND ALL MATCHING CHAPTERS
        // ============================================

        const matchingChapters =
            sortChaptersForAttempt(
                chapters,
                chapterNumber
            );

        if (!matchingChapters.length) {

            throw new Error(
                `Chapter ${chapterNumber} was not found on MangaDex for "${title}".`
            );
        }

        console.log(
            `[MangaDex] ${matchingChapters.length} matching chapter record(s) found`
        );

        // ============================================
        // 4. TRY EACH MATCHING CHAPTER
        // ============================================

        const attempted = [];

        for (
            const chapter of matchingChapters
        ) {

            const chapterID =
                chapter.id;

            const attributes =
                chapter.attributes || {};

            console.log(
                `[MangaDex] Trying chapter ${attributes.chapter} (${chapterID})`
            );

            const pages =
                await getAtHomePages(
                    chapterID
                );

            if (
                pages &&
                pages.length
            ) {

                console.log(
                    `[MangaDex] Success: ${pages.length} pages`
                );

                return {
                    title,

                    chapter:
                        attributes.chapter ||
                        String(chapterNumber),

                    source:
                        "MangaDex",

                    pages
                };
            }

            attempted.push(
                chapterID
            );
        }

        // ============================================
        // 5. NOTHING HAD READER PAGES
        // ============================================

        throw new Error(
            `MangaDex found chapter ${chapterNumber} for "${title}", but none of the matching chapter records have usable reader pages. Tried ${attempted.length} record(s).`
        );
    }
};
