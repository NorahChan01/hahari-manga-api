const axios = require("axios");
const crypto = require("crypto");

const BASE_URL = "https://mangadenizi.net";
const API_URL = `${BASE_URL}/api/v1/web`;

const http = axios.create({
    timeout: 30000,
    maxRedirects: 5,
    responseType: "json",
    headers: {
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/139.0.0.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9"
    }
});

function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function slugify(value) {
    return normalize(value)
        .replace(/\s+/g, "-");
}

function numberEqual(a, b) {
    const x = Number(a);
    const y = Number(b);

    return Number.isFinite(x) &&
        Number.isFinite(y) &&
        x === y;
}

/*
 * Search manga through MangaDenizi's public API.
 */
async function findManga(title) {
    const wanted = normalize(title);

    /*
     * MangaDenizi's API has paginated manga data.
     *
     * We scan pages until we find an exact/close title.
     */
    for (let page = 1; page <= 20; page++) {
        try {
            const response = await http.get(
                `${API_URL}/manga?page=${page}`
            );

            const list =
                response.data?.data?.manga?.data;

            if (!Array.isArray(list) || !list.length) {
                break;
            }

            let best = null;
            let bestScore = 0;

            for (const manga of list) {
                if (!manga?.title || !manga?.slug) {
                    continue;
                }

                const found = normalize(manga.title);

                let score = 0;

                if (found === wanted) {
                    score = 1000;
                } else if (found.includes(wanted)) {
                    score = 800;
                } else if (wanted.includes(found)) {
                    score = 700;
                } else {
                    const wantedWords =
                        new Set(wanted.split(/\s+/));

                    const foundWords =
                        new Set(found.split(/\s+/));

                    let common = 0;

                    for (const word of wantedWords) {
                        if (foundWords.has(word)) {
                            common++;
                        }
                    }

                    score = common * 50;
                }

                if (score > bestScore) {
                    bestScore = score;

                    best = {
                        title: manga.title,
                        slug: manga.slug
                    };
                }
            }

            if (best) {
                return best;
            }
        } catch (error) {
            /*
             * Don't immediately kill the search.
             * Try the next page.
             */
        }
    }

    /*
     * Direct slug fallback.
     */
    const slug = slugify(title);

    try {
        const response = await http.get(
            `${API_URL}/manga/${encodeURIComponent(slug)}`
        );

        const manga =
            response.data?.data?.manga;

        if (manga?.slug && manga?.title) {
            return {
                title: manga.title,
                slug: manga.slug
            };
        }
    } catch (_) {}

    return null;
}

/*
 * MangaDenizi's current API returns chapters from:
 *
 * /api/v1/web/manga/{slug}
 */
async function getChapters(manga) {
    const response = await http.get(
        `${API_URL}/manga/${encodeURIComponent(manga.slug)}`
    );

    const chapters =
        response.data?.data?.manga?.chapters;

    if (!Array.isArray(chapters)) {
        throw new Error(
            "MangaDenizi returned no chapter list."
        );
    }

    return chapters;
}

/*
 * Get the actual reader payload.
 *
 * Current endpoint:
 *
 * /api/v1/web/read/{manga-slug}/{chapter-slug}/payload
 */
async function getPayload(mangaSlug, chapterSlug) {
    const response = await http.get(
        `${API_URL}/read/` +
        `${encodeURIComponent(mangaSlug)}/` +
        `${encodeURIComponent(chapterSlug)}/payload`
    );

    const pages = response.data?.pages;

    if (!Array.isArray(pages)) {
        throw new Error(
            "MangaDenizi returned an invalid reader payload."
        );
    }

    return pages;
}

/*
 * XorShift32 used by MangaDenizi's tiled-v1 algorithm.
 *
 * This mirrors the current HaruNeko implementation.
 */
class PRNG {
    constructor(init, salt) {
        const seed =
            ((Number(init) >>> 0) ^
                (Number(salt) >>> 0)) >>> 0;

        this.seed =
            seed || 0x9E3779B9;

        this.state = this.seed;
    }

    next() {
        this.state =
            (this.state ^
                ((this.state << 13) >>> 0)) >>> 0;

        this.state =
            (this.state ^
                (this.state >>> 17)) >>> 0;

        this.state =
            (this.state ^
                ((this.state << 5) >>> 0)) >>> 0;

        return this.state >>> 0;
    }

    sequence(count) {
        this.state = this.seed;

        const indices =
            Array.from(
                { length: Math.max(1, count) },
                (_, i) => i
            );

        for (
            let current = indices.length - 1;
            current > 0;
            current--
        ) {
            const randomIndex =
                this.next() % (current + 1);

            [
                indices[current],
                indices[randomIndex]
            ] = [
                indices[randomIndex],
                indices[current]
            ];
        }

        return indices;
    }
}

/*
 * MangaDenizi's XOR decrypt.
 *
 * The current reader uses the X-Scramble-Key response
 * header as a one-byte XOR key.
 */
function decryptXOR(buffer, key) {
    const data = Buffer.from(buffer);

    const value =
        Number(key) & 0xff;

    for (let i = 0; i < data.length; i++) {
        data[i] ^= value;
    }

    return data;
}

/*
 * Calculate the regions exactly like MangaDenizi.
 */
function splitDimension(totalSize, regionCount) {
    const size =
        Math.max(1, Math.floor(totalSize));

    const count =
        Math.max(
            1,
            Math.min(
                Math.floor(regionCount) || 1,
                size
            )
        );

    const regions = [];

    for (
        let regionIndex = 0;
        regionIndex < count;
        regionIndex++
    ) {
        const startOffset =
            Math.floor(
                regionIndex * size / count
            );

        const endOffset =
            Math.floor(
                (regionIndex + 1) *
                size / count
            );

        regions.push({
            offset: startOffset,
            length:
                Math.max(
                    1,
                    endOffset - startOffset
                )
        });
    }

    return regions;
}

/*
 * Tiled-v1 descrambling.
 *
 * Uses sharp to crop the scrambled tiles and
 * composite them into their original positions.
 */
async function decryptTiledV1(
    inputBuffer,
    seed,
    grid,
    sharp
) {
    const metadata =
        await sharp(inputBuffer).metadata();

    const width =
        Math.max(
            1,
            Math.floor(metadata.width || 1)
        );

    const height =
        Math.max(
            1,
            Math.floor(metadata.height || 1)
        );

    const gridSize =
        Math.max(
            1,
            Math.min(
                Math.floor(grid) || 1,
                width,
                height
            )
        );

    const columns =
        splitDimension(
            width,
            gridSize
        );

    const rows =
        splitDimension(
            height,
            gridSize
        );

    const shuffledColumns =
        new PRNG(
            seed,
            0x85EBCA6B
        ).sequence(gridSize);

    const shuffledRows =
        new PRNG(
            seed,
            0x9E3779B9
        ).sequence(gridSize);

    const composites = [];

    for (
        let row = 0;
        row < gridSize;
        row++
    ) {
        const srcY = rows[row];

        const dstY =
            rows[shuffledRows[row]];

        for (
            let column = 0;
            column < gridSize;
            column++
        ) {
            const srcX =
                columns[column];

            const dstX =
                columns[
                    shuffledColumns[column]
                ];

            /*
             * Crop the source tile.
             */
            const tile =
                await sharp(inputBuffer)
                    .extract({
                        left: srcX.offset,
                        top: srcY.offset,
                        width: srcX.length,
                        height: srcY.length
                    })
                    .toBuffer();

            composites.push({
                input: tile,
                left: dstX.offset,
                top: dstY.offset
            });
        }
    }

    /*
     * Rebuild the image.
     */
    return await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: {
                r: 0,
                g: 0,
                b: 0,
                alpha: 0
            }
        }
    })
        .composite(composites)
        .png()
        .toBuffer();
}

/*
 * Download and descramble one MangaDenizi image.
 *
 * This function is exported so the API server can use it
 * for the /api/manga/image endpoint.
 */
async function processImage(
    imageUrl,
    scramble = {},
    sharp
) {
    const response =
        await axios.get(
            imageUrl,
            {
                responseType: "arraybuffer",
                timeout: 30000,
                maxRedirects: 5,
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                        "AppleWebKit/537.36 (KHTML, like Gecko) " +
                        "Chrome/139.0.0.0 Safari/537.36",
                    "Referer":
                        `${BASE_URL}/`
                }
            }
        );

    const algorithm =
        scramble.method ||
        response.headers[
            "x-scramble-method"
        ] ||
        response.headers[
            "x-scrambled-method"
        ];

    if (algorithm === "xor") {
        const key =
            scramble.key !== undefined
                ? scramble.key
                : parseInt(
                    response.headers[
                        "x-scramble-key"
                    ],
                    10
                );

        if (!Number.isFinite(key)) {
            throw new Error(
                "MangaDenizi XOR image has no scramble key."
            );
        }

        return {
            buffer: decryptXOR(
                response.data,
                key
            ),
            contentType:
                response.headers["content-type"] ||
                "image/jpeg"
        };
    }

    if (algorithm === "tiled-v1") {
        const seed =
            scramble.seed !== undefined
                ? scramble.seed
                : parseInt(
                    response.headers[
                        "x-scramble-seed"
                    ],
                    10
                );

        const grid =
            scramble.grid !== undefined
                ? scramble.grid
                : parseInt(
                    response.headers[
                        "x-scramble-grid"
                    ],
                    10
                );

        if (
            !Number.isFinite(seed) ||
            !Number.isFinite(grid)
        ) {
            throw new Error(
                "MangaDenizi tiled image is missing seed/grid."
            );
        }

        const buffer =
            await decryptTiledV1(
                response.data,
                seed,
                grid,
                sharp
            );

        return {
            buffer,
            contentType: "image/png"
        };
    }

    /*
     * Unscrambled image.
     */
    return {
        buffer: Buffer.from(
            response.data
        ),
        contentType:
            response.headers["content-type"] ||
            "image/jpeg"
    };
}

async function getChapter(title, chapter) {
    if (!title) {
        throw new Error(
            "Manga title is required."
        );
    }

    if (
        chapter === undefined ||
        chapter === null ||
        String(chapter).trim() === ""
    ) {
        throw new Error(
            "Chapter number is required."
        );
    }

    /*
     * Find manga.
     */
    const manga =
        await findManga(title);

    if (!manga) {
        throw new Error(
            `Manga "${title}" was not found on MangaDenizi.`
        );
    }

    /*
     * Get chapter list.
     */
    const chapters =
        await getChapters(manga);

    /*
     * Find exact chapter.
     */
    const selected =
        chapters.find(item =>
            numberEqual(
                item.number,
                chapter
            )
        );

    if (!selected) {
        throw new Error(
            `Chapter ${chapter} was not found for "${manga.title}" on MangaDenizi.`
        );
    }

    /*
     * Get reader payload.
     */
    const readerPages =
        await getPayload(
            manga.slug,
            selected.slug
        );

    if (!readerPages.length) {
        throw new Error(
            `MangaDenizi returned no pages for "${manga.title}" chapter ${chapter}.`
        );
    }

    /*
     * We don't return the raw image URLs directly.
     *
     * The API server will expose a proxy endpoint that
     * descrambles them before manga.js downloads them.
     */
    const pages =
        readerPages.map(page => ({
            image_url: page.image_url,
            scramble: page.scramble || {}
        }));

    return {
        success: true,
        title: manga.title,
        chapter: String(chapter),
        source: "MangaDenizi",
        pages
    };
}

module.exports = {
    name: "MangaDenizi",
    getChapter,
    processImage
};
