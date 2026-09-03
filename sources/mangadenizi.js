const axios = require("axios");

const BASE_URL = "https://mangadenizi.net";
const API_BASE = `${BASE_URL}/api/v1/web`;

const SOURCE_NAME = "MangaDenizi";

const DEFAULT_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/139.0.0.0 Safari/537.36",

    "Accept":
        "application/json, text/plain, */*",

    "Accept-Language":
        "en-US,en;q=0.9",

    "Referer":
        `${BASE_URL}/`
};

/*
 * Normalize text for manga title matching.
 */
function normalize(text) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/*
 * Convert manga title into a likely slug.
 */
function slugify(text) {
    return normalize(text)
        .replace(/\s+/g, "-");
}

/*
 * GET helper.
 */
async function apiGet(url, options = {}) {

    return axios.get(
        url,
        {
            timeout: 30000,

            maxRedirects: 5,

            headers: {
                ...DEFAULT_HEADERS,
                ...(options.headers || {})
            },

            ...options
        }
    );
}

/*
 * Convert to unsigned 32-bit integer.
 */
function uint32(value) {
    return Number(value) >>> 0;
}

/*
 * MangaDenizi XorShift32 PRNG.
 */
function xorshift32(state) {

    state = uint32(state);

    state ^=
        uint32(
            state << 13
        );

    state ^=
        state >>> 17;

    state ^=
        uint32(
            state << 5
        );

    return uint32(state);
}

/*
 * Generate MangaDenizi Fisher-Yates shuffle.
 */
function makeShuffle(
    size,
    seed,
    salt
) {

    const result =
        Array.from(
            {
                length: size
            },
            (_, i) => i
        );

    let state =
        uint32(seed) ^
        uint32(salt);

    if (state === 0) {
        state = 0x9E3779B9;
    }

    for (
        let i = result.length - 1;
        i > 0;
        i--
    ) {

        state =
            xorshift32(state);

        const j =
            state %
            (i + 1);

        const temp =
            result[i];

        result[i] =
            result[j];

        result[j] =
            temp;
    }

    return result;
}

/*
 * XOR descrambling.
 */
function xorBuffer(
    buffer,
    key
) {

    if (
        key === undefined ||
        key === null
    ) {
        return buffer;
    }

    let numericKey = key;

    if (
        typeof numericKey === "string"
    ) {

        const trimmed =
            numericKey.trim();

        if (
            /^0x[0-9a-f]+$/i.test(trimmed)
        ) {

            numericKey =
                parseInt(
                    trimmed,
                    16
                );

        } else {

            numericKey =
                Number(trimmed);
        }
    }

    numericKey =
        Number(numericKey);

    if (
        !Number.isFinite(
            numericKey
        )
    ) {
        return buffer;
    }

    numericKey =
        numericKey & 0xff;

    const output =
        Buffer.from(buffer);

    for (
        let i = 0;
        i < output.length;
        i++
    ) {

        output[i] ^=
            numericKey;
    }

    return output;
}

/*
 * Convert MangaDenizi seed to uint32.
 */
function parseSeed(value) {

    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    if (
        typeof value === "number" &&
        Number.isFinite(value)
    ) {

        return uint32(value);
    }

    const text =
        String(value).trim();

    if (!text) {
        return null;
    }

    if (
        /^0x[0-9a-f]+$/i.test(text)
    ) {

        return uint32(
            parseInt(
                text,
                16
            )
        );
    }

    const number =
        Number(text);

    if (
        Number.isFinite(number)
    ) {

        return uint32(number);
    }

    return null;
}

/*
 * Parse MangaDenizi grid.
 *
 * IMPORTANT:
 *
 * MangaDenizi's tiled-v1 payload uses:
 *
 *     grid: 4
 *
 * NOT:
 *
 *     { columns: 4, rows: 4 }
 *
 * The single number means:
 *
 *     4 x 4
 */
function parseGrid(grid) {

    if (
        grid === undefined ||
        grid === null ||
        grid === ""
    ) {
        return null;
    }

    /*
     * Normal MangaDenizi format:
     *
     * grid = number
     */
    const value =
        Number(grid);

    if (
        Number.isInteger(value) &&
        value > 0
    ) {

        return value;
    }

    /*
     * Fallback for array format.
     */
    if (
        Array.isArray(grid)
    ) {

        const first =
            Number(grid[0]);

        if (
            Number.isInteger(first) &&
            first > 0
        ) {

            return first;
        }

        return null;
    }

    /*
     * Fallback for object format.
     */
    if (
        typeof grid === "object"
    ) {

        const objectValue =
            Number(
                grid.columns ??
                grid.cols ??
                grid.x ??
                grid.width ??
                grid.rows ??
                grid.y ??
                grid.height
            );

        if (
            Number.isInteger(
                objectValue
            ) &&
            objectValue > 0
        ) {

            return objectValue;
        }
    }

    return null;
}

/*
 * Split a dimension into equal regions.
 *
 * This follows MangaDenizi's region calculation:
 *
 * start = floor(index * size / count)
 * end   = floor((index + 1) * size / count)
 */
function splitDimension(
    totalSize,
    regionCount
) {

    const size =
        Math.max(
            1,
            Math.floor(totalSize)
        );

    const count =
        Math.max(
            1,
            Math.min(
                Math.floor(regionCount),
                size
            )
        );

    return Array.from(
        {
            length: count
        },
        (_, index) => {

            const start =
                Math.floor(
                    index *
                    size /
                    count
                );

            const end =
                Math.floor(
                    (index + 1) *
                    size /
                    count
                );

            return {
                offset: start,

                length:
                    Math.max(
                        1,
                        end - start
                    )
            };
        }
    );
}

/*
 * Reconstruct a MangaDenizi tiled-v1 image.
 */
async function untileImage(
    buffer,
    seed,
    grid
) {

    const sharp =
        require("sharp");

    const gridSize =
        parseGrid(grid);

    if (!gridSize) {

        throw new Error(
            "Invalid MangaDenizi tile grid."
        );
    }

    const metadata =
        await sharp(buffer)
            .metadata();

    const width =
        metadata.width;

    const height =
        metadata.height;

    if (
        !width ||
        !height
    ) {

        throw new Error(
            "Could not determine image dimensions."
        );
    }

    /*
     * Do not allow the grid to exceed
     * the actual image dimensions.
     */
    const actualGrid =
        Math.max(
            1,
            Math.min(
                Math.floor(gridSize),
                width,
                height
            )
        );

    /*
     * Split image into MangaDenizi regions.
     */
    const columnRegions =
        splitDimension(
            width,
            actualGrid
        );

    const rowRegions =
        splitDimension(
            height,
            actualGrid
        );

    /*
     * MangaDenizi salts.
     */
    const COLUMN_SALT =
        0x85EBCA6B;

    const ROW_SALT =
        0x9E3779B9;

    /*
     * Generate the exact column/row shuffles.
     */
    const shuffledColumns =
        makeShuffle(
            actualGrid,
            seed,
            COLUMN_SALT
        );

    const shuffledRows =
        makeShuffle(
            actualGrid,
            seed,
            ROW_SALT
        );

    const composites = [];

    /*
     * Extract every scrambled tile.
     */
    for (
        let row = 0;
        row < actualGrid;
        row++
    ) {

        const sourceY =
            rowRegions[row];

        const destinationY =
            rowRegions[
                shuffledRows[row]
            ];

        for (
            let column = 0;
            column < actualGrid;
            column++
        ) {

            const sourceX =
                columnRegions[column];

            const destinationX =
                columnRegions[
                    shuffledColumns[column]
                ];

            /*
             * Extract source tile.
             */
            let tile =
                await sharp(buffer)
                    .extract({
                        left:
                            sourceX.offset,

                        top:
                            sourceY.offset,

                        width:
                            sourceX.length,

                        height:
                            sourceY.length
                    })
                    .png()
                    .toBuffer();

            /*
             * MangaDenizi's browser implementation
             * draws each tile into the destination
             * rectangle, meaning dimensions may need
             * to be scaled.
             */
            if (
                sourceX.length !==
                    destinationX.length ||
                sourceY.length !==
                    destinationY.length
            ) {

                tile =
                    await sharp(tile)
                        .resize({
                            width:
                                destinationX.length,

                            height:
                                destinationY.length,

                            fit:
                                "fill"
                        })
                        .png()
                        .toBuffer();
            }

            composites.push({
                input: tile,

                left:
                    destinationX.offset,

                top:
                    destinationY.offset
            });
        }
    }

    /*
     * Rebuild final image.
     */
    return sharp({
        create: {
            width,
            height,

            channels: 4,

            background: {
                r: 255,
                g: 255,
                b: 255,
                alpha: 1
            }
        }
    })
        .composite(
            composites
        )
        .png()
        .toBuffer();
}

/*
 * Process one MangaDenizi image.
 *
 * Supports:
 *
 *     xor
 *     tiled-v1
 *     normal
 */
async function processImage(
    imageUrl,
    scramble = {}
) {

    /*
     * Sharp intentionally loaded here.
     */
    const sharp =
        require("sharp");

    if (!imageUrl) {

        throw new Error(
            "Missing MangaDenizi image URL."
        );
    }

    let response;

    try {

        response =
            await axios.get(
                imageUrl,
                {
                    responseType:
                        "arraybuffer",

                    timeout:
                        30000,

                    maxRedirects:
                        5,

                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                            "AppleWebKit/537.36 (KHTML, like Gecko) " +
                            "Chrome/139.0.0.0 Safari/537.36",

                        "Accept":
                            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",

                        "Referer":
                            `${BASE_URL}/`
                    }
                }
            );

    } catch (error) {

        throw new Error(
            `Failed to download MangaDenizi image: ${error.message}`
        );
    }

    let buffer =
        Buffer.from(
            response.data
        );

    const headers =
        response.headers || {};

    /*
     * Determine scramble method.
     */
    const method =
        String(
            scramble.method ||
            headers["x-scramble-method"] ||
            ""
        )
            .trim()
            .toLowerCase();

    /*
     * XOR scrambling.
     */
    if (
        method === "xor"
    ) {

        const key =
            scramble.key ??
            scramble.seed ??
            headers["x-scramble-key"];

        buffer =
            xorBuffer(
                buffer,
                key
            );

        return {
            buffer,

            contentType:
                "image/png"
        };
    }

    /*
     * Tiled-v1 scrambling.
     */
    if (
        method === "tiled-v1" ||
        method === "tiled"
    ) {

        const seed =
            parseSeed(
                scramble.seed ??
                headers["x-scramble-seed"]
            );

        /*
         * MangaDenizi normally supplies grid
         * inside the reader payload.
         *
         * Header is only a fallback.
         */
        const grid =
            parseGrid(
                scramble.grid ??
                headers["x-scramble-grid"]
            );

        if (
            seed === null
        ) {

            throw new Error(
                "MangaDenizi tiled-v1 image is missing its scramble seed."
            );
        }

        if (
            !grid
        ) {

            throw new Error(
                "MangaDenizi tiled-v1 image is missing its scramble grid."
            );
        }

        buffer =
            await untileImage(
                buffer,
                seed,
                grid
            );

        return {
            buffer,

            contentType:
                "image/png"
        };
    }

    /*
     * No scrambling.
     */
    let contentType =
        headers["content-type"];

    if (
        !contentType ||
        !String(contentType)
            .toLowerCase()
            .startsWith("image/")
    ) {

        try {

            const metadata =
                await sharp(buffer)
                    .metadata();

            if (
                metadata.format ===
                "webp"
            ) {

                contentType =
                    "image/webp";

            } else if (
                metadata.format ===
                "jpeg"
            ) {

                contentType =
                    "image/jpeg";

            } else if (
                metadata.format ===
                "png"
            ) {

                contentType =
                    "image/png";

            } else {

                contentType =
                    "image/png";
            }

        } catch {

            contentType =
                "image/png";
        }
    }

    return {
        buffer,
        contentType
    };
}

/*
 * Find MangaDenizi manga.
 */
async function findManga(
    mangaName
) {

    const wanted =
        normalize(mangaName);

    if (!wanted) {
        return null;
    }

    /*
     * Search public MangaDenizi pages.
     */
    for (
        let page = 1;
        page <= 10;
        page++
    ) {

        try {

            const response =
                await apiGet(
                    `${API_BASE}/manga?page=${page}`
                );

            const mangas =
                response.data?.data?.mangas ||
                response.data?.data?.items ||
                response.data?.mangas ||
                [];

            if (
                !Array.isArray(
                    mangas
                )
            ) {
                continue;
            }

            for (
                const manga of mangas
            ) {

                const title =
                    manga.title ||
                    manga.name ||
                    "";

                const slug =
                    manga.slug ||
                    "";

                if (!slug) {
                    continue;
                }

                const normalizedTitle =
                    normalize(title);

                const normalizedSlug =
                    normalize(slug);

                if (
                    normalizedTitle ===
                        wanted ||
                    normalizedSlug ===
                        wanted
                ) {

                    return {
                        title,
                        slug
                    };
                }
            }

        } catch (error) {

            console.log(
                `[${SOURCE_NAME}] Manga list page ${page} failed: ${error.message}`
            );
        }
    }

    /*
     * Direct slug fallback.
     */
    const possibleSlugs = [
        slugify(mangaName),

        String(mangaName)
            .trim()
            .toLowerCase()
            .replace(
                /\s+/g,
                "-"
            )
    ];

    for (
        const slug of possibleSlugs
    ) {

        if (!slug) {
            continue;
        }

        try {

            const response =
                await apiGet(
                    `${API_BASE}/manga/${encodeURIComponent(slug)}`
                );

            const manga =
                response.data?.data?.manga;

            if (manga) {

                return {
                    title:
                        manga.title ||
                        manga.name ||
                        mangaName,

                    slug:
                        manga.slug ||
                        slug
                };
            }

        } catch {
            // Try next slug.
        }
    }

    return null;
}

/*
 * Get manga chapters.
 */
async function getChapters(
    manga
) {

    const response =
        await apiGet(
            `${API_BASE}/manga/${encodeURIComponent(manga.slug)}`
        );

    const chapters =
        response.data?.data?.manga?.chapters ||
        [];

    if (
        !Array.isArray(
            chapters
        )
    ) {
        return [];
    }

    return chapters;
}

/*
 * Match requested chapter.
 */
function chapterMatches(
    chapter,
    requested
) {

    const requestedText =
        String(requested)
            .trim();

    const number =
        chapter?.number;

    if (
        number !== undefined &&
        number !== null
    ) {

        if (
            String(number)
                .trim() ===
            requestedText
        ) {

            return true;
        }

        const a =
            Number(number);

        const b =
            Number(requested);

        if (
            Number.isFinite(a) &&
            Number.isFinite(b) &&
            a === b
        ) {

            return true;
        }
    }

    const title =
        String(
            chapter?.title ||
            ""
        );

    const slug =
        String(
            chapter?.slug ||
            ""
        );

    const combined =
        `${title} ${slug}`;

    const requestedNumber =
        Number(requested);

    if (
        Number.isFinite(
            requestedNumber
        )
    ) {

        const matches =
            combined.match(
                /(?:chapter|chap|bolum|bölüm)[^\d]*(\d+(?:\.\d+)?)/i
            );

        if (matches) {

            const found =
                Number(
                    matches[1]
                );

            if (
                found ===
                requestedNumber
            ) {

                return true;
            }
        }
    }

    return false;
}

/*
 * Get MangaDenizi reader payload.
 */
async function getReaderPayload(
    manga,
    chapter
) {

    const url =
        `${API_BASE}/read/` +
        `${encodeURIComponent(manga.slug)}/` +
        `${encodeURIComponent(chapter.slug)}/payload`;

    const response =
        await apiGet(url);

    return response.data;
}

/*
 * Public source interface.
 */
module.exports = {

    name:
        SOURCE_NAME,

    /*
     * Fetch chapter.
     */
    async getChapter(
        mangaName,
        chapterNumber
    ) {

        console.log(
            `[${SOURCE_NAME}] Searching: ${mangaName} chapter ${chapterNumber}`
        );

        /*
         * Find manga.
         */
        const manga =
            await findManga(
                mangaName
            );

        if (!manga) {

            throw new Error(
                `Manga "${mangaName}" was not found on MangaDenizi.`
            );
        }

        console.log(
            `[${SOURCE_NAME}] Found manga: ${manga.title} (${manga.slug})`
        );

        /*
         * Fetch chapters.
         */
        const chapters =
            await getChapters(
                manga
            );

        if (
            !chapters.length
        ) {

            throw new Error(
                `No chapters found for "${manga.title}" on MangaDenizi.`
            );
        }

        /*
         * Find requested chapter.
         */
        const chapter =
            chapters.find(
                item =>
                    chapterMatches(
                        item,
                        chapterNumber
                    )
            );

        if (!chapter) {

            throw new Error(
                `Chapter ${chapterNumber} was not found for "${manga.title}" on MangaDenizi.`
            );
        }

        console.log(
            `[${SOURCE_NAME}] Found chapter: ` +
            `${chapter.title || chapter.number} ` +
            `(${chapter.slug})`
        );

        /*
         * Get reader payload.
         */
        const payload =
            await getReaderPayload(
                manga,
                chapter
            );

        const pages =
            Array.isArray(
                payload?.pages
            )
                ? payload.pages
                : [];

        if (
            !pages.length
        ) {

            throw new Error(
                `MangaDenizi returned no reader pages for "${manga.title}" chapter ${chapterNumber}.`
            );
        }

        /*
         * Preserve image URL + scramble data.
         */
        const normalizedPages =
            pages
                .map(page => {

                    if (
                        typeof page ===
                        "string"
                    ) {

                        return {
                            image_url:
                                page,

                            scramble: {}
                        };
                    }

                    return {
                        image_url:
                            page?.image_url ||
                            page?.url ||
                            page?.src ||
                            "",

                        scramble:
                            page?.scramble ||
                            {}
                    };
                })
                .filter(
                    page =>
                        page.image_url
                );

        if (
            !normalizedPages.length
        ) {

            throw new Error(
                "MangaDenizi reader returned pages, but no usable image URLs were found."
            );
        }

        /*
         * Return in the format expected
         * by the API index.js.
         */
        return {

            title:
                manga.title ||
                mangaName,

            chapter:
                String(
                    chapter.number ??
                    chapter.title ??
                    chapterNumber
                ),

            source:
                SOURCE_NAME,

            pages:
                normalizedPages
        };
    },

    /*
     * Used by index.js image proxy.
     */
    processImage
};
