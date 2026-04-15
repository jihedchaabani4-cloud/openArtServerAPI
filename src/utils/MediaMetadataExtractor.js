/**
 * MediaMetadataExtractor.js
 * Server-side media metadata extraction.
 * - Images: uses `sharp` (width, height, format, file size)
 * - Videos: pure Node.js MP4 box parser (width, height, duration in seconds)
 */

import sharp from 'sharp';

// ── Helper: compute GCD for ratio simplification ─────────────────────────────
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function simplifyRatio(w, h) {
    const d = gcd(Math.round(w), Math.round(h));
    return `${Math.round(w / d)}:${Math.round(h / d)}`;
}

// ── Image Metadata (via sharp) ───────────────────────────────────────────────
export async function extractImageMetadata(buffer, mime) {
    try {
        const meta = await sharp(buffer).metadata();
        const w = meta.width;
        const h = meta.height;
        const fileSizeBytes = buffer.length;
        const fileSizeKB = Math.round(fileSizeBytes / 1024);
        const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

        return {
            width:     w,
            height:    h,
            ratio:     simplifyRatio(w, h),
            size:      `${w}x${h}`,
            format:    meta.format?.toUpperCase() || mime?.split('/')[1]?.toUpperCase(),
            file_size: fileSizeBytes,
            file_size_label: fileSizeKB >= 1024
                ? `${fileSizeMB} MB`
                : `${fileSizeKB} KB`,
        };
    } catch (err) {
        console.warn('[MetadataExtractor] Image parsing failed:', err.message);
        return null;
    }
}

// ── Video Metadata (pure Node.js MP4 box parser) ─────────────────────────────
/**
 * Parses an MP4/MOV buffer to extract width, height, and duration.
 * Walks the top-level 'moov' > 'mvhd' box for duration and timescale.
 * Walks 'moov' > 'trak' > 'tkhd' box for track dimensions.
 */
export function extractVideoMetadata(buffer, mime) {
    try {
        const fileSizeBytes = buffer.length;
        const fileSizeKB = Math.round(fileSizeBytes / 1024);
        const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

        const base = {
            file_size: fileSizeBytes,
            file_size_label: fileSizeKB >= 1024 ? `${fileSizeMB} MB` : `${fileSizeKB} KB`,
            format: mime?.split('/')[1]?.toUpperCase() || 'VIDEO',
        };

        // Only MP4/MOV have parseable moov boxes easily
        if (!['video/mp4', 'video/quicktime'].includes(mime)) return base;

        let offset = 0;
        let moovOffset = -1;

        // Find the 'moov' box
        while (offset + 8 <= buffer.length) {
            const size = buffer.readUInt32BE(offset);
            const type = buffer.slice(offset + 4, offset + 8).toString('ascii');
            if (type === 'moov') { moovOffset = offset; break; }
            if (size < 8) break;
            offset += size;
        }

        if (moovOffset === -1) return base;

        // Walk inside moov to find mvhd (duration) and tkhd (width/height)
        let duration = null, timescale = null, width = null, height = null;
        let moovSize = buffer.readUInt32BE(moovOffset);
        let inner = moovOffset + 8;
        const moovEnd = moovOffset + moovSize;

        while (inner + 8 <= moovEnd) {
            const boxSize = buffer.readUInt32BE(inner);
            const boxType = buffer.slice(inner + 4, inner + 8).toString('ascii');

            if (boxType === 'mvhd' && inner + 100 <= buffer.length) {
                const version = buffer.readUInt8(inner + 8);
                if (version === 1) {
                    timescale = buffer.readUInt32BE(inner + 28);
                    duration  = Number(buffer.readBigUInt64BE(inner + 32));
                } else {
                    timescale = buffer.readUInt32BE(inner + 20);
                    duration  = buffer.readUInt32BE(inner + 24);
                }
            }

            // tkhd box (first video track usually) contains display w/h
            if (boxType === 'trak') {
                let tkhdOffset = inner + 8;
                while (tkhdOffset + 8 <= inner + boxSize) {
                    const tSize = buffer.readUInt32BE(tkhdOffset);
                    const tType = buffer.slice(tkhdOffset + 4, tkhdOffset + 8).toString('ascii');
                    if (tType === 'tkhd' && tkhdOffset + 90 <= buffer.length) {
                        const v = buffer.readUInt8(tkhdOffset + 8);
                        const wOffset = v === 1 ? tkhdOffset + 76 : tkhdOffset + 60;
                        // Width/height in 16.16 fixed-point format
                        const rawW = buffer.readUInt32BE(wOffset);
                        const rawH = buffer.readUInt32BE(wOffset + 4);
                        const tw = rawW >> 16;
                        const th = rawH >> 16;
                        if (tw > 0 && th > 0) { width = tw; height = th; }
                        break;
                    }
                    if (tSize < 8) break;
                    tkhdOffset += tSize;
                }
            }

            if (boxSize < 8) break;
            inner += boxSize;
        }

        const durationSec = (timescale && duration)
            ? Math.round((duration / timescale) * 100) / 100
            : null;

        return {
            ...base,
            ...(width && height ? {
                width,
                height,
                ratio: simplifyRatio(width, height),
                size: `${width}x${height}`,
            } : {}),
            ...(durationSec !== null ? {
                duration_sec:   durationSec,
                duration_label: formatDuration(durationSec),
            } : {}),
        };
    } catch (err) {
        console.warn('[MetadataExtractor] Video parsing failed:', err.message);
        return null;
    }
}

function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Router: dispatch to correct extractor ────────────────────────────────────
export async function extractMediaMetadata(buffer, mime) {
    if (!buffer || !mime) return null;
    if (mime.startsWith('image/')) return await extractImageMetadata(buffer, mime);
    if (mime.startsWith('video/')) return extractVideoMetadata(buffer, mime);
    return null;
}
