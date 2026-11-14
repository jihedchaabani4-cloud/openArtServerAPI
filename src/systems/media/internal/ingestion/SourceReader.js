/**
 * SourceReader
 * Safely streams and buffers input sources (File, Base64, URL).
 * Enforces strict per-type byte-level limits during streaming/decoding via early magic-byte sniffing,
 * and validates each redirect against SSRF policy.
 */

import { SourcePolicy } from "./SourcePolicy.js";
import { MediaInspector } from "./MediaInspector.js";
import { DEFAULT_UPLOAD_POLICY } from "./UploadPolicy.js";
import { ValidationError, createPayloadTooLargeError } from "../errors.js";

const MB = 1024 * 1024;
const MAGIC_HEADER_MIN_BYTES = 32;
const BASE64_HEADER_SLICE_CHARS = 48; // 48 base64 chars = 36 decoded bytes
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function resolvePolicyByteLimits(policyOrProfile = DEFAULT_UPLOAD_POLICY) {
    const imageLimit = policyOrProfile.maxImageSize ?? policyOrProfile.imageLimit ?? 20 * MB;
    const videoLimit =
        policyOrProfile.maxVideoSize ??
        policyOrProfile.videoLimit ??
        (policyOrProfile.maxSizeBytes ?? 100 * MB);
    const outerLimit = policyOrProfile.maxSizeBytes ?? Math.max(imageLimit, videoLimit);
    const allowedTypes =
        policyOrProfile.allowedTypes ?? (videoLimit > 0 ? ["image", "video"] : ["image"]);

    return { imageLimit, videoLimit, outerLimit, allowedTypes };
}

function sniffAndResolveByteCap(headerBytes, limits) {
    let sniffedMime = null;
    try {
        sniffedMime = MediaInspector.sniffMagicBytes(headerBytes.subarray(0, MAGIC_HEADER_MIN_BYTES));
    } catch (sniffErr) {
        throw new ValidationError(
            `[SourcePolicy] File format validation failed: ${sniffErr.message}`,
            { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }
        );
    }

    if (!sniffedMime) {
        throw new ValidationError(
            "[SourcePolicy] File format validation failed: unrecognized or unsupported MIME magic-byte signature.",
            { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }
        );
    }

    const detectedType = sniffedMime.startsWith("video/") ? "video" : "image";
    if (!limits.allowedTypes.includes(detectedType)) {
        throw new ValidationError(
            `[SourcePolicy] File format "${sniffedMime}" is not allowed for this operation.`,
            { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }
        );
    }

    const effectiveLimit = detectedType === "video" ? limits.videoLimit : limits.imageLimit;
    return { sniffedMime, detectedType, effectiveLimit };
}

function estimateBase64DecodedBytes(pureBase64) {
    if (!pureBase64.length) return 0;
    const padding = pureBase64.endsWith("==") ? 2 : (pureBase64.endsWith("=") ? 1 : 0);
    return Math.floor((pureBase64.length * 3) / 4) - padding;
}

function createStreamExceededError(limitBytes) {
    const maxMB = (limitBytes / MB).toFixed(1);
    return new ValidationError(
        `[SourceReader] File stream exceeded maximum allowed size of ${maxMB}MB during download.`,
        { statusCode: 413, code: "PAYLOAD_TOO_LARGE" }
    );
}

export class SourceReader {
    static async read(descriptor, policyOrProfile = DEFAULT_UPLOAD_POLICY) {
        if (!descriptor || !descriptor.kind) {
            throw new ValidationError("[SourceReader] Invalid source descriptor.", {
                statusCode: 400,
                code: "VALIDATION_ERROR",
            });
        }

        const limits = resolvePolicyByteLimits(policyOrProfile);
        if (descriptor.kind === "file") return this._readFile(descriptor, limits);
        if (descriptor.kind === "base64") return this._readBase64(descriptor, limits);
        if (descriptor.kind === "url") return this._readUrl(descriptor.value || descriptor.url, limits);

        throw new ValidationError(`[SourceReader] Cannot read source kind: "${descriptor.kind}".`, {
            statusCode: 400,
            code: "VALIDATION_ERROR",
        });
    }

    static _readFile(descriptor, limits) {
        const buf = descriptor.buffer;
        if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
            throw new ValidationError("[SourceReader] Missing or empty file buffer.", {
                statusCode: 400,
                code: "VALIDATION_ERROR",
            });
        }

        const { effectiveLimit } = sniffAndResolveByteCap(buf.subarray(0, MAGIC_HEADER_MIN_BYTES), limits);
        if (buf.length > effectiveLimit) {
            throw createPayloadTooLargeError(buf.length, effectiveLimit, "[SourceReader] Uploaded file");
        }

        return {
            buffer: buf,
            sizeBytes: buf.length,
            originalName: descriptor.originalName || "upload.bin",
            mimeHint: descriptor.mimeHint || null,
        };
    }

    /**
     * @deprecated Scheduled for removal in Ticket 10 once all frontend callers
     * migrate to FormData (new File) and mediaId (Project Cache).
     */
    static _readBase64(descriptor, limits) {
        const raw = descriptor.value || "";
        const pureBase64 = (raw.includes(",") ? raw.split(",")[1] : raw).trim();
        if (!pureBase64) {
            throw new ValidationError("[SourceReader] Decoded base64 payload is empty.", {
                statusCode: 400,
                code: "VALIDATION_ERROR",
            });
        }

        const headerBytes = Buffer.from(pureBase64.slice(0, BASE64_HEADER_SLICE_CHARS), "base64");
        const { effectiveLimit } = sniffAndResolveByteCap(headerBytes, limits);
        const estimatedBytes = estimateBase64DecodedBytes(pureBase64);
        if (estimatedBytes > effectiveLimit) {
            throw createPayloadTooLargeError(estimatedBytes, effectiveLimit, "[SourceReader] Base64 payload");
        }

        const buf = Buffer.from(pureBase64, "base64");
        if (!buf.length) {
            throw new ValidationError("[SourceReader] Decoded base64 payload is empty.", {
                statusCode: 400,
                code: "VALIDATION_ERROR",
            });
        }
        if (buf.length > effectiveLimit) {
            throw createPayloadTooLargeError(buf.length, effectiveLimit, "[SourceReader] Base64 payload");
        }

        return {
            buffer: buf,
            sizeBytes: buf.length,
            originalName: descriptor.originalName || "base64_upload.bin",
            mimeHint: descriptor.mimeHint || null,
        };
    }

    /**
     * @deprecated Scheduled for removal in Ticket 10 once all frontend callers
     * migrate to FormData (new File) and mediaId (Project Cache).
     */
    static async _readUrl(initialUrl, limits) {
        let currentUrl = initialUrl;
        const maxRedirects = 3;

        for (let hop = 0; hop <= maxRedirects; hop++) {
            const validatedUrl = await SourcePolicy.validateUrl(currentUrl);
            const { res, controller, timeout } = await this._fetchUrlHop(validatedUrl, currentUrl);

            if (REDIRECT_STATUSES.has(res.status)) {
                currentUrl = this._resolveRedirectTarget(res, validatedUrl, currentUrl, hop, maxRedirects, timeout);
                continue;
            }

            if (!res.ok) {
                clearTimeout(timeout);
                throw new ValidationError(
                    `[SourceReader] Remote server responded with error ${res.status}: ${res.statusText}`
                );
            }

            return this._readValidatedUrlResponse({ res, validatedUrl, controller, timeout, limits });
        }

        throw new ValidationError("[SourceReader] Failed to complete download.");
    }

    static async _fetchUrlHop(validatedUrl, currentUrl) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        try {
            const res = await fetch(validatedUrl.toString(), {
                signal: controller.signal,
                redirect: "manual",
                headers: {
                    "User-Agent": "OpenArt-MediaIngestion/1.0",
                    Accept: "image/*,video/*;q=0.9,*/*;q=0.5",
                },
            });
            return { res, controller, timeout };
        } catch (err) {
            clearTimeout(timeout);
            if (err.name === "AbortError") {
                throw new ValidationError(`[SourceReader] Request to "${currentUrl}" timed out after 25 seconds.`);
            }
            throw new ValidationError(`[SourceReader] Failed to fetch remote URL: ${err.message}`);
        }
    }

    static _resolveRedirectTarget(res, validatedUrl, currentUrl, hop, maxRedirects, timeout) {
        clearTimeout(timeout);
        const location = res.headers.get("location");
        if (!location) {
            throw new ValidationError(`[SourceReader] Redirect received without Location header from "${currentUrl}".`);
        }
        if (hop === maxRedirects) {
            throw new ValidationError(`[SourceReader] Too many redirects (maximum allowed: ${maxRedirects}).`);
        }
        return new URL(location, validatedUrl).toString();
    }

    static async _readValidatedUrlResponse({ res, validatedUrl, controller, timeout, limits }) {
        const declaredBytes = Number(res.headers.get("content-length"));
        if (!Number.isNaN(declaredBytes) && declaredBytes > limits.outerLimit) {
            clearTimeout(timeout);
            throw createPayloadTooLargeError(declaredBytes, limits.outerLimit, "[SourceReader] Remote file size");
        }

        const buffer = await this._consumeUrlStream({ res, controller, timeout, declaredBytes, limits });
        const mimeHint = res.headers.get("content-type")?.split(";")[0]?.trim() || null;
        const pathname = validatedUrl.pathname;
        const originalName = pathname.substring(pathname.lastIndexOf("/") + 1) || "remote_media.bin";

        return { buffer, sizeBytes: buffer.length, originalName, mimeHint };
    }

    static async _consumeUrlStream({ res, controller, timeout, declaredBytes, limits }) {
        const state = {
            chunks: [],
            totalBytes: 0,
            headerBuffer: Buffer.alloc(0),
            headerSniffed: false,
            activeLimitBytes: limits.outerLimit,
        };

        try {
            for await (const rawChunk of res.body) {
                const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                this._appendUrlStreamChunk({ chunk, state, controller, declaredBytes, limits });
            }
            if (state.totalBytes === 0) {
                throw new ValidationError("[SourceReader] Remote URL returned an empty response body.", {
                    statusCode: 400,
                    code: "VALIDATION_ERROR",
                });
            }
            if (!state.headerSniffed && state.headerBuffer.length > 0) {
                const { effectiveLimit } = sniffAndResolveByteCap(state.headerBuffer, limits);
                if (state.totalBytes > effectiveLimit) {
                    throw createPayloadTooLargeError(state.totalBytes, effectiveLimit, "[SourceReader] Remote file size");
                }
            }
            return Buffer.concat(state.chunks);
        } catch (streamErr) {
            if (streamErr instanceof ValidationError) throw streamErr;
            if (streamErr.name === "AbortError" && state.totalBytes > state.activeLimitBytes) {
                throw createStreamExceededError(state.activeLimitBytes);
            }
            throw new ValidationError(streamErr.message || "[SourceReader] Stream read failed.", {
                cause: streamErr,
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    static _appendUrlStreamChunk({ chunk, state, controller, declaredBytes, limits }) {
        if (!state.headerSniffed) {
            state.headerBuffer = Buffer.concat([state.headerBuffer, chunk]);
            if (state.headerBuffer.length >= MAGIC_HEADER_MIN_BYTES) {
                state.headerSniffed = true;
                const { effectiveLimit } = sniffAndResolveByteCap(
                    state.headerBuffer.subarray(0, MAGIC_HEADER_MIN_BYTES),
                    limits
                );
                state.activeLimitBytes = effectiveLimit;

                if (!Number.isNaN(declaredBytes) && declaredBytes > state.activeLimitBytes) {
                    controller.abort();
                    throw createPayloadTooLargeError(declaredBytes, state.activeLimitBytes, "[SourceReader] Remote file size");
                }
            }
        }

        state.totalBytes += chunk.length;
        if (state.totalBytes > state.activeLimitBytes) {
            controller.abort();
            throw createStreamExceededError(state.activeLimitBytes);
        }
        state.chunks.push(chunk);
    }
}

export default SourceReader;
