const axios = require("axios");

const API = "https://api.comick.io";

const TIMEOUT = 20000;

function normalize(value) {

    return String(value || "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function sameChapter(a, b) {

    const x =
        Number(String(a).match(/\d+(?:\.\d+)?/)?.[0]);

    const y =
        Number(String(b).match(/\d+(?:\.\d+)?/)?.[0]);

    if (Number.isNaN(x) || Number.isNaN(y)) {
        return false;
    }

    return x === y;
}

function score(query, title) {

    const q = normalize(query);
    const t = normalize(title);

    if (q === t) return 100;
    if (t.includes(q)) return 95;
    if (q.includes(t)) return 90;

    const words = q.split(" ");
    const target = new Set(t.split(" "));

    let matches = 0;

    for (const word of words) {
        if (target.has(word)) {
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
        `${API}/v1.0/search`,
        {
            params: {
                q: title
            },
            headers: {
                "User-Agent":
                    "Mozilla/5.0",
                Referer:
                    "https://comick.io/"
            },
            timeout: TIMEOUT
        }
    );

    return Array.isArray(response.data)
        ? response.data
        : response.data?.data || [];
}

async function getChapters(hid, wanted) {

    for (let page = 1; page <= 20; page++) {

        const response =
            await axios.get(
                `${API}/comic/${hid}/chapters`,
                {
                    params: {
                        page,
                        limit: 100,
                        lang: "en"
                    },
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0",
                        Referer:
                            "https://comick.io/"
                    },
                    timeout: TIMEOUT
                }
            );

        const chapters =
            response.data?.chapters || [];

        const found =
            chapters.find(ch =>
                sameChapter(
                    ch.chap,
                    wanted
                )
            );

        if (found) {
            return found;
        }

        if (chapters.length < 100) {
            break;
        }
    }

    return null;
}

async function getImages(
    slug,
    chapter
) {

    const url =
        `https://comick.io/comic/${slug}/${chapter.hid}-chapter-${chapter.chap}-${chapter.lang}`;

    const response =
        await axios.get(
            url,
            {
                headers: {
                    "User-Agent":
                        "Mozilla/5.0",
                    Referer:
                        "https://comick.io/"
                },
                timeout: TIMEOUT
            }
        );

    const match =
        response.data.match(
            /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
        );

    if (!match) {
        throw new Error(
            "Could not read Comick chapter data."
        );
    }

    const data =
        JSON.parse(match[1]);

    const images =
        data?.props?.pageProps?.chapter?.md_images;

    if (!Array.isArray(images) || !images.length) {
        throw new Error(
            "Comick returned no chapter images."
        );
    }

    return images
        .filter(image => image?.b2key)
        .map(image =>
            `https://meo.comick.pictures/${image.b2key}`
        );
}

module.exports = {

    name: "Comick",

    async getChapter(
        title,
        wantedChapter
    ) {

        const results =
            await search(title);

        if (!results.length) {
            throw new Error(
                "No Comick search results."
            );
        }

        const ranked =
            results
                .map(item => ({
                    item,
                    title:
                        item.title ||
                        item.name ||
                        "",
                    score:
                        score(
                            title,
                            item.title ||
                            item.name ||
                            ""
                        )
                }))
                .sort(
                    (a, b) =>
                        b.score - a.score
                );

        for (
            const candidate of ranked.slice(0, 8)
        ) {

            const manga =
                candidate.item;

            const hid =
                manga.hid ||
                manga.id;

            const slug =
                manga.slug ||
                manga.slug_name;

            if (!hid || !slug) {
                continue;
            }

            try {

                const chapter =
                    await getChapters(
                        hid,
                        wantedChapter
                    );

                if (!chapter) {
                    continue;
                }

                const pages =
                    await getImages(
                        slug,
                        chapter
                    );

                return {
                    title:
                        manga.title ||
                        manga.name ||
                        title,

                    chapter:
                        chapter.chap ||
                        wantedChapter,

                    pages
                };

            } catch (_) {

                continue;
            }
        }

        throw new Error(
            `Chapter ${wantedChapter} not found on Comick.`
        );
    }
};
