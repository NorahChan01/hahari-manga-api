const axios = require("axios");

const API = "https://api.mangadex.org";

const client = axios.create({
    timeout: 30000,
    headers: {
        "User-Agent": "HahariBot/1.0",
        "Accept": "application/json"
    }
});

function showError(error) {
    if (error.response) {
        return `HTTP ${error.response.status}: ${
            typeof error.response.data === "string"
                ? error.response.data.slice(0, 300)
                : JSON.stringify(error.response.data).slice(0, 500)
        }`;
    }

    return error.message;
}

module.exports = {
    name: "MangaDex",

    async getChapter(mangaName, chapterNumber) {

        // ============================================
        // 1. SEARCH MANGA
        // ============================================

        let search;

        try {

            search = await client.get(
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

            throw new Error(
                `MangaDex manga search failed: ${showError(error)}`
            );
        }

        const mangas =
            search.data?.data || [];

        if (!mangas.length) {

            throw new Error(
                `MangaDex found no manga for "${mangaName}".`
            );
        }

        // ============================================
        // 2. SHOW SEARCH RESULTS
        // ============================================

        console.log(
            `[MangaDex] Search "${mangaName}" returned ${mangas.length} results`
        );

        mangas.forEach((manga, index) => {

            const titles =
                Object.values(
                    manga.attributes?.title || {}
                );

            console.log(
                `[MangaDex] #${index + 1}: ${titles.join(" | ")}`
            );
        });

        // ============================================
        // 3. FIND BEST TITLE
        // ============================================

        const query =
            mangaName
                .toLowerCase()
                .trim();

        function normalize(text) {

            return String(text || "")
                .toLowerCase()
                .replace(/[’'`]/g, "")
                .replace(/[^a-z0-9]+/g, " ")
                .replace(/\s+/g, " ")
                .trim();
        }

        const normalizedQuery =
            normalize(query);

        let bestManga = null;
        let bestScore = -1;

        for (const manga of mangas) {

            const titleObject =
                manga.attributes?.title || {};

            const altTitles =
                manga.attributes?.altTitles || [];

            const titleValues = [
                ...Object.values(titleObject),
                ...altTitles.flatMap(
                    obj => Object.values(obj || {})
                )
            ];

            let score = 0;

            for (const value of titleValues) {

                const normalized =
                    normalize(value);

                if (!normalized) continue;

                if (
                    normalized ===
                    normalizedQuery
                ) {
                    score = Math.max(
                        score,
                        1000
                    );
                }

                else if (
                    normalized.includes(
                        normalizedQuery
                    )
                ) {
                    score = Math.max(
                        score,
                        800
                    );
                }

                else if (
                    normalizedQuery.includes(
                        normalized
                    )
                ) {
                    score = Math.max(
                        score,
                        700
                    );
                }

                const queryWords =
                    normalizedQuery.split(" ");

                const titleWords =
                    normalized.split(" ");

                const common =
                    queryWords.filter(
                        word =>
                            word.length >= 3 &&
                            titleWords.includes(word)
                    ).length;

                if (common) {

                    score = Math.max(
                        score,
                        common * 100
                    );
                }
            }

            if (score > bestScore) {

                bestScore = score;
                bestManga = manga;
            }
        }

        if (!bestManga) {

            throw new Error(
                `MangaDex could not select a manga for "${mangaName}".`
            );
        }

        const mangaID =
            bestManga.id;

        const titleObject =
            bestManga.attributes?.title || {};

        const title =
            titleObject.en ||
            Object.values(titleObject)[0] ||
            mangaName;

        console.log(
            `[MangaDex] Selected: ${title} (${mangaID}) score=${bestScore}`
        );

        // ============================================
        // 4. FIND CHAPTERS
        // ============================================

        let chapters = [];
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

                throw new Error(
                    `MangaDex chapter request failed: ${showError(error)}`
                );
            }

            const data =
                response.data?.data || [];

            chapters.push(...data);

            const total =
                response.data?.total ||
                chapters.length;

            if (
                data.length === 0 ||
                chapters.length >= total
            ) {
                break;
            }

            offset += data.length;

            if (offset >= 1000) {
                break;
            }
        }

        console.log(
            `[MangaDex] Found ${chapters.length} chapters`
        );

        // ============================================
        // 5. FIND REQUESTED CHAPTER
        // ============================================

        const wanted =
            String(chapterNumber).trim();

        let chapter =
            chapters.find(
                c =>
                    String(
                        c.attributes?.chapter || ""
                    ).trim() === wanted
            );

        if (!chapter) {

            const wantedNumber =
                Number(wanted);

            if (
                Number.isFinite(
                    wantedNumber
                )
            ) {

                chapter =
                    chapters.find(c => {

                        const value =
                            c.attributes?.chapter;

                        if (!value) {
                            return false;
                        }

                        return (
                            Number(value) ===
                            wantedNumber
                        );
                    });
            }
        }

        if (!chapter) {

            const available =
                chapters
                    .map(
                        c =>
                            c.attributes?.chapter
                    )
                    .filter(Boolean)
                    .slice(0, 30);

            throw new Error(
                `MangaDex chapter ${wanted} not found for "${title}". Available examples: ${available.join(", ")}`
            );
        }

        console.log(
            `[MangaDex] Chapter selected: ${chapter.id}`
        );

        // ============================================
        // 6. AT-HOME SERVER
        // ============================================

        let atHome;

        try {

            atHome =
                await client.get(
                    `${API}/at-home/server/${chapter.id}`
                );

        } catch (error) {

            throw new Error(
                `MangaDex at-home request failed: ${showError(error)}`
            );
        }

        const data =
            atHome.data;

        if (!data?.baseUrl) {

            throw new Error(
                "MangaDex did not return baseUrl."
            );
        }

        const hash =
            data.chapter?.hash;

        const files =
            data.chapter?.data || [];

        if (
            !hash ||
            !files.length
        ) {

            throw new Error(
                "MangaDex returned no page files."
            );
        }

        // ============================================
        // 7. BUILD PAGES
        // ============================================

        const pages =
            files.map(
                file =>
                    `${data.baseUrl}/data/${hash}/${file}`
            );

        console.log(
            `[MangaDex] Returning ${pages.length} pages`
        );

        return {
            title,

            chapter:
                chapter.attributes?.chapter ||
                wanted,

            source:
                "MangaDex",

            pages
        };
    }
};
