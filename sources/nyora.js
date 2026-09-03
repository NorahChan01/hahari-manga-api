const NyoraSDK = require("nyora-sdk");

const client = new NyoraSDK();

function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function chapterMatches(value, wanted) {
    if (value == null) return false;

    const a = String(value).trim();
    const b = String(wanted).trim();

    if (a === b) return true;

    const na = Number(a);
    const nb = Number(b);

    return (
        Number.isFinite(na) &&
        Number.isFinite(nb) &&
        na === nb
    );
}

module.exports = {
    name: "Nyora",

    async getChapter(mangaName, chapterNumber) {

        // =====================================================
        // 1. GET AVAILABLE SOURCES
        // =====================================================

        const sources =
            await client.sources.list();

        if (
            !Array.isArray(sources) ||
            !sources.length
        ) {
            throw new Error(
                "Nyora returned no available manga sources."
            );
        }

        // =====================================================
        // 2. SEARCH ACROSS SOURCES
        // =====================================================

        const query =
            normalize(mangaName);

        let bestManga = null;
        let bestSource = null;

        for (const source of sources) {

            try {

                const results =
                    await client.manga.search(
                        source.id,
                        mangaName
                    );

                const entries =
                    results?.entries || [];

                if (!entries.length) {
                    continue;
                }

                // Exact title first.
                let match =
                    entries.find(item =>
                        normalize(item.title) === query
                    );

                // Partial title second.
                if (!match) {
                    match =
                        entries.find(item => {

                            const title =
                                normalize(item.title);

                            return (
                                title.includes(query) ||
                                query.includes(title)
                            );
                        });
                }

                // Otherwise first result.
                if (!match) {
                    match = entries[0];
                }

                if (match) {
                    bestManga = match;
                    bestSource = source;
                    break;
                }

            } catch (error) {
                console.log(
                    `[Nyora] ${source.id}:`,
                    error.message
                );
            }
        }

        if (!bestManga || !bestSource) {
            throw new Error(
                `Nyora could not find "${mangaName}" on its available sources.`
            );
        }

        // =====================================================
        // 3. GET MANGA DETAILS
        // =====================================================

        const details =
            await client.manga.details(
                bestSource.id,
                bestManga.url,
                {
                    title:
                        bestManga.title
                }
            );

        const chapters =
            details?.chapters || [];

        if (!chapters.length) {
            throw new Error(
                `No chapters found for "${bestManga.title}".`
            );
        }

        // =====================================================
        // 4. FIND CHAPTER
        // =====================================================

        const chapter =
            chapters.find(ch =>
                chapterMatches(
                    ch.number,
                    chapterNumber
                )
            );

        if (!chapter) {
            throw new Error(
                `Chapter ${chapterNumber} was not found on ${bestSource.name || bestSource.id}.`
            );
        }

        // =====================================================
        // 5. GET PAGE IMAGES
        // =====================================================

        const pages =
            await client.manga.pages(
                bestSource.id,
                chapter.url,
                {
                    branch:
                        chapter.branch
                }
            );

        if (
            !Array.isArray(pages) ||
            !pages.length
        ) {
            throw new Error(
                "Nyora returned no chapter pages."
            );
        }

        // =====================================================
        // 6. EXTRACT IMAGE URLS
        // =====================================================

        const imageURLs =
            pages
                .map(page => {

                    if (
                        typeof page === "string"
                    ) {
                        return page;
                    }

                    return page?.url || null;
                })
                .filter(url =>
                    typeof url === "string" &&
                    (
                        url.startsWith("http://") ||
                        url.startsWith("https://")
                    )
                );

        if (!imageURLs.length) {
            throw new Error(
                "Nyora returned pages but no usable image URLs."
            );
        }

        // =====================================================
        // 7. STANDARD HAHARI RESPONSE
        // =====================================================

        return {
            title:
                bestManga.title ||
                mangaName,

            chapter:
                String(
                    chapter.number ??
                    chapterNumber
                ),

            pages: imageURLs,

            source:
                bestSource.name ||
                bestSource.id
        };
    }
};
