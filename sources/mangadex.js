const axios = require("axios");

const API = "https://api.mangadex.org";

const TIMEOUT = 20000;

function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function chapterNumber(value) {

    if (value === undefined || value === null) {
        return null;
    }

    const match = String(value)
        .trim()
        .match(/\d+(?:\.\d+)?/);

    return match ? Number(match[0]) : null;
}

function sameChapter(a, b) {

    const x = chapterNumber(a);
    const y = chapterNumber(b);

    return (
        x !== null &&
        y !== null &&
        Math.abs(x - y) < 0.00001
    );
}

function getTitle(manga) {

    const titles =
        manga?.attributes?.title || {};

    return (
        titles.en ||
        Object.values(titles)[0] ||
        ""
    );
}

function scoreTitle(query, title) {

    const q = normalize(query);
    const t = normalize(title);

    if (!q || !t) return 0;

    if (q === t) return 100;

    if (t.includes(q)) return 95;

    if (q.includes(t)) return 90;

    const words = q.split(" ");
    const titleWords = new Set(t.split(" "));

    let matches = 0;

    for (const word of words) {
        if (titleWords.has(word)) {
            matches++;
        }
    }

    return (
        matches /
        Math.max(words.length, 1)
    ) * 80;
}

async function search(title) {

    const response = await axios.get(
        `${API}/manga`,
        {
            params: {
                title,
                limit: 10,
                contentRating: [
                    "safe",
                    "suggestive",
                    "erotica"
                ]
            },
            timeout: TIMEOUT
        }
    );

    return response.data?.data || [];
}

async function getChapters(mangaId) {

    let chapters = [];
    let offset = 0;

    for (let i = 0; i < 10; i++) {

        const response = await axios.get(
            `${API}/chapter`,
            {
                params: {
                    manga: mangaId,
                    translatedLanguage: ["en"],
                    limit: 100,
                    offset,
                    "order[chapter]": "asc"
                },
                timeout: TIMEOUT
            }
        );

        const data =
            response.data?.data || [];

        chapters.push(...data);

        if (data.length < 100) {
            break;
        }

        offset += 100;
    }

    return chapters;
}

async function getPages(chapterId) {

    const response = await axios.get(
        `${API}/at-home/server/${chapterId}`,
        {
            timeout: TIMEOUT
        }
    );

    const chapter =
        response.data?.chapter;

    if (!chapter) {
        throw new Error(
            "MangaDex returned no chapter data."
        );
    }

    if (
        !chapter.baseUrl ||
        !chapter.hash ||
        !Array.isArray(chapter.data)
    ) {
        throw new Error(
            "MangaDex returned invalid page data."
        );
    }

    return chapter.data.map(file =>
        `${chapter.baseUrl}/data/${chapter.hash}/${file}`
    );
}

module.exports = {

    name: "MangaDex",

    async getChapter(title, wantedChapter) {

        const results =
            await search(title);

        if (!results.length) {
            throw new Error(
                "No manga search results."
            );
        }

        const ranked =
            results
                .map(manga => ({
                    manga,
                    title: getTitle(manga),
                    score: scoreTitle(
                        title,
                        getTitle(manga)
                    )
                }))
                .sort(
                    (a, b) =>
                        b.score - a.score
                );

        /*
         * Check multiple search results.
         * This is important for titles such as
         * "100 girlfriends".
         */

        for (const candidate of ranked) {

            const manga =
                candidate.manga;

            if (!manga?.id) {
                continue;
            }

            try {

                const chapters =
                    await getChapters(
                        manga.id
                    );

                const chapter =
                    chapters.find(item =>
                        sameChapter(
                            item.attributes?.chapter,
                            wantedChapter
                        )
                    );

                if (!chapter) {
                    continue;
                }

                const pages =
                    await getPages(
                        chapter.id
                    );

                return {
                    title:
                        getTitle(manga) ||
                        title,

                    chapter:
                        chapter.attributes?.chapter ||
                        wantedChapter,

                    pages
                };

            } catch (error) {

                /*
                 * If one MangaDex result is broken,
                 * check the next result.
                 */

                continue;
            }
        }

        throw new Error(
            `Chapter ${wantedChapter} not found on MangaDex.`
        );
    }
};
