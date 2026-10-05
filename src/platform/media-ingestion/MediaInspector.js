/**
 * MediaInspector
 * Deep content inspection, magic-bytes sniffing, and metadata extraction.
 * Never trusts remote server claims or browser headers.
 */

import sharp from "sharp";
import { extractVideoMetadata } from "../../utils/MediaMetadataExtractor.js";
import { calculateAspectRatio } from "../../utils/ratioUtils.js";

function getResolutionLabel(w, h) {
    if (!w || !h) return null;
    const min = Math.min(w, h);
    if (min >= 2160) return "4K";
    if (min >= 1440) return "1440p";
    if (min >= 1080) return "1080p";
    if (min >= 720) return "720p";
    if (min >= 480) return "480p";
    return `${min}p`;
}

export class MediaInspector {
    /**
     * Sniffs magic bytes to determine the true content type.
     *
     * @param {Buffer} buffer
     * @returns {string | null} Detected MIME type
     */
    static sniffMagicBytes(buffer) {
        if (!buffer || buffer.length < 4) return null;

        // 1. Dangerous signatures detection
        // Windows PE (MZ)
        if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
            throw new Error("[MediaInspector] Executable binary payload (MZ) detected. Ingestion rejected.");
        }
        // Linux ELF
        if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
            throw new Error("[MediaInspector] Executable ELF binary detected. Ingestion rejected.");
        }
        // HTML / Script sniffing (XSS payload in image disguise)
        const headerText = buffer.slice(0, 256).toString("utf8").toLowerCase();
        if (
            headerText.includes("<!doctype") ||
            headerText.includes("<html") ||
            headerText.includes("<script") ||
            headerText.includes("<?php")
        ) {
            throw new Error("[MediaInspector] HTML / Script markup payload detected. Ingestion rejected.");
        }
        // SVG / XML sniffing
        if (
            headerText.includes("<svg") ||
            headerText.includes("<?xml") ||
            headerText.includes("<xml") ||
            headerText.includes("xmlns=\"http://www.w3.org/2000/svg\"")
        ) {
            throw new Error("[MediaInspector] SVG / XML markup payload detected. Vector graphics and scriptable XML are not permitted in raster image ingestion.");
        }
        // ZIP archive signatures (PK\x03\x04, PK\x05\x06, PK\x07\x08)
        if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
            throw new Error("[MediaInspector] ZIP archive payload (PK) detected. Ingestion rejected.");
        }

        // 2. Image Signatures
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (
            buffer[0] === 0x89 &&
            buffer[1] === 0x50 &&
            buffer[2] === 0x4e &&
            buffer[3] === 0x47 &&
            buffer[4] === 0x0d &&
            buffer[5] === 0x0a &&
            buffer[6] === 0x1a &&
            buffer[7] === 0x0a
        ) {
            return "image/png";
        }

        // JPEG: FF D8 FF
        if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
            return "image/jpeg";
        }

        // GIF: GIF87a or GIF89a
        if (
            buffer[0] === 0x47 &&
            buffer[1] === 0x49 &&
            buffer[2] === 0x46 &&
            buffer[3] === 0x38
        ) {
            return "image/gif";
        }

        // WebP: RIFF....WEBP
        if (
            buffer.length >= 12 &&
            buffer.slice(0, 4).toString("ascii") === "RIFF" &&
            buffer.slice(8, 12).toString("ascii") === "WEBP"
        ) {
            return "image/webp";
        }

        // 3. Video / ISO Box Signatures (MP4, MOV, AVIF)
        if (buffer.length >= 12 && buffer.slice(4, 8).toString("ascii") === "ftyp") {
            const brand = buffer.slice(8, 12).toString("ascii").toLowerCase();
            if (brand.includes("avif") || brand.includes("avis")) {
                return "image/avif";
            }
            if (brand.includes("qt")) {
                return "video/quicktime";
            }
            return "video/mp4";
        }

        // WebM / Matroska: 1A 45 DF A3
        if (
            buffer[0] === 0x1a &&
            buffer[1] === 0x45 &&
            buffer[2] === 0xdf &&
            buffer[3] === 0xa3
        ) {
            return "video/webm";
        }

        return null;
    }

    /**
     * Deeply inspects the buffer, verifies claimed vs detected format,
     * and extracts exact dimensions, duration, and resolution.
     *
     * @param {Buffer} buffer
     * @param {string | null} [claimedMime]
     * @returns {Promise<{
     *   isValid: boolean,
     *   detectedMime: string,
     *   type: "image" | "video",
     *   format: string,
     *   width: number,
     *   height: number,
     *   durationSec: number | null,
     *   ratio: string,
     *   resolution: string | null,
     *   sizeBytes: number
     * }>}
     */
    static async inspect(buffer, claimedMime = null) {
        if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
            throw new Error("[MediaInspector] Buffer is empty or invalid.");
        }

        const detectedMime = this.sniffMagicBytes(buffer);
        if (!detectedMime) {
            throw new Error(
                `[MediaInspector] Unrecognized or unsupported file format (detected: null, claimed: "${claimedMime}").`
            );
        }

        if (claimedMime && !claimedMime.startsWith("multipart/") && !claimedMime.startsWith("application/octet-stream")) {
            const bothVideo = claimedMime.startsWith("video/") && detectedMime.startsWith("video/");
            const bothImage = claimedMime.startsWith("image/") && detectedMime.startsWith("image/");
            if (!bothVideo && !bothImage && claimedMime !== detectedMime) {
                throw new Error(
                    `[MediaInspector] Content inspection failed: declared MIME "${claimedMime}" does not match file bytes ("${detectedMime}").`
                );
            }
        }

        const effectiveMime = detectedMime;
        const isVideo = effectiveMime.startsWith("video/");
        const isImage = effectiveMime.startsWith("image/");

        const sizeBytes = buffer.length;

        // ── Video Inspection ──────────────────────────────────────────────────
        if (isVideo) {
            const videoMeta = extractVideoMetadata(buffer, effectiveMime);
            const width = videoMeta.width || null;
            const height = videoMeta.height || null;
            const durationSec = videoMeta.duration_sec || null;

            return {
                isValid: true,
                detectedMime: effectiveMime,
                type: "video",
                format: videoMeta.format || "MP4",
                width: width || 1920,
                height: height || 1080,
                durationSec,
                ratio: width && height ? calculateAspectRatio(width, height) : "16:9",
                resolution: width && height ? getResolutionLabel(width, height) : null,
                sizeBytes,
            };
        }

        // ── Image Inspection (via Sharp) ──────────────────────────────────────
        try {
            const meta = await sharp(buffer).metadata();
            if (!meta || !meta.width || !meta.height) {
                throw new Error("Sharp could not decode image headers.");
            }

            let width = meta.width;
            let height = meta.height;

            // Handle EXIF orientation: orientations 5, 6, 7, 8 rotate 90 or 270 degrees,
            // which flips width and height in the browser.
            if (meta.orientation && meta.orientation >= 5 && meta.orientation <= 8) {
                width = meta.height;
                height = meta.width;
            }

            const format = (meta.format || effectiveMime.split("/")[1] || "JPEG").toUpperCase();

            // Canonicalize detected MIME based on sharp's decoded format if magic bytes were ambiguous
            let finalMime = effectiveMime;
            if (meta.format === "jpeg") finalMime = "image/jpeg";
            else if (meta.format === "png") finalMime = "image/png";
            else if (meta.format === "webp") finalMime = "image/webp";
            else if (meta.format === "avif") finalMime = "image/avif";
            else if (meta.format === "gif") finalMime = "image/gif";

            return {
                isValid: true,
                detectedMime: finalMime,
                type: "image",
                format,
                width,
                height,
                durationSec: null,
                ratio: calculateAspectRatio(width, height),
                resolution: getResolutionLabel(width, height),
                sizeBytes,
            };
        } catch (sharpErr) {
            throw new Error(
                `[MediaInspector] Image content inspection failed (claimed "${claimedMime}", detected "${detectedMime}"): ${sharpErr.message}`
            );
        }
    }
}

export default MediaInspector;
