const axios = require("axios");

const API = "https://api.mangadex.org";

module.exports = {
    name: "MangaDex",

    async getChapter(mangaName, chapterNumber) {

        // =====================================================
        // 1. SEARCH MANGA
        // =====================================================

        const search = await axios.get(`${API}/manga`, {
            params: {
                title: mangaName,
                limit: 10,
                "contentRating[]": [
                    "safe",
                    "suggestive",
                    "erotica"
                ],
                "includes[]": "cover_art"
            },
            timeout: 20000,
            headers: {
                "User-Agent": "HahariBot/1.0"
            }
        });

        const mangas = search.data?.data || [];

        if (!mangas.length) {
            throw new Error(
                `No manga found for "${mangaName}".`
            );
        }

        // =====================================================
        // 2. TITLE MATCH
        // =====================================================

        const normalizedQuery =
            mangaName.toLowerCase().trim();

        let manga = mangas.find(m => {

            const attrs = m.attributes || {};

            const titles =
                Object.values(attrs.title || {})
                    .join(" ")
                    .toLowerCase()
                    .trim();

            return titles === normalizedQuery;
        });

        if (!manga) {
            manga = mangas[0];
        }

        const mangaID = manga.id;

        const attributes =
            manga.attributes || {};

        const titleObject =
            attributes.title || {};

        const title =
            titleObject.en ||
            Object.values(titleObject)[0] ||
            mangaName;

        // =====================================================
        // 3. FIND CHAPTER
        // =====================================================

        const chapters = [];

        let offset = 0;

        while (true) {

            const chapterResponse =
                await axios.get(
                    `${API}/chapter`,
                    {
                        params: {
                            manga: mangaID,

                            translatedLanguage: ["en"],

                            "contentRating[]": [
                                "safe",
                                "suggestive",
                                "erotica"
                            ],

                            limit: 100,
                            offset,

                            order: {
                                chapter: "asc"
                            }
                        },

                        timeout: 20000,

                        headers: {
                            "User-Agent":
                                "HahariBot/1.0"
                        }
                    }
                );

            const data =
                chapterResponse.data?.data || [];

            chapters.push(...data);

            const total =
                chapterResponse.data?.total ||
                chapters.length;

            if (
                chapters.length >= total ||
                data.length === 0
            ) {
                break;
            }

            offset += data.length;

            if (offset >= 1000) {
                break;
            }
        }

        // =====================================================
        // 4. EXACT CHAPTER MATCH
        // =====================================================

        let chapter = chapters.find(c => {

            const value =
                c.attributes?.chapter;

            return value === String(chapterNumber);
        });

        // Numeric fallback

        if (!chapter) {

            chapter = chapters.find(c => {

                const value =
                    c.attributes?.chapter;

                if (!value) {
                    return false;
                }

                return (
                    Number(value) ===
                    Number(chapterNumber)
                );
            });
        }

        if (!chapter) {

            throw new Error(
                `Chapter ${chapterNumber} was not found on MangaDex.`
            );
        }

        // =====================================================
        // 5. AT-HOME SERVER
        // =====================================================

        const chapterID =
            chapter.id;

        const atHome =
            await axios.get(
                `${API}/at-home/server/${chapterID}`,
                {
                    timeout: 30000,

                    headers: {
                        "User-Agent":
                            "HahariBot/1.0"
                    }
                }
            );

        const atHomeData =
            atHome.data;

        if (!atHomeData?.baseUrl) {

            throw new Error(
                "MangaDex did not return a page server."
            );
        }

        const hash =
            atHomeData.chapter?.hash;

        const pageFiles =
            atHomeData.chapter?.data || [];

        if (!hash || !pageFiles.length) {

            throw new Error(
                "No manga pages were returned."
            );
        }

        // =====================================================
        // 6. BUILD PAGE URLS
        // =====================================================

        const pages =
            pageFiles.map(file => {

                return (
                    `${atHomeData.baseUrl}` +
                    `/data/${hash}/${file}`
                );
            });

        return {
            title,
            chapter:
                chapter.attributes?.chapter ||
                String(chapterNumber),

            pages
        };
    }
};
