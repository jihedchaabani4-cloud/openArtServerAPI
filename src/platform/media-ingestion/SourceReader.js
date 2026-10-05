/**
 * SourceReader
 * Safely streams and buffers input sources (File, Base64, URL).
 * Enforces strict byte-level limits during streaming and validates each redirect against SSRF policy.
 */

import { SourcePolicy } from "./SourcePolicy.js";

export class SourceReader {
    /**
     * Reads a resolved source descriptor and returns verified buffer payload.
     *
     * @param {{
     *   kind: "file" | "base64" | "url",
     *   buffer?: Buffer,
     *   value?: string,
     *   originalName?: string,
     *   mimeHint?: string | null
     * }} descriptor
     * @param {Object} profile - Policy profile containing maxSizeBytes
     * @returns {Promise<{
     *   buffer: Buffer,
     *   sizeBytes: number,
     *   originalName: string,
     *   mimeHint: string | null
     * }>}
     */
    static async read(descriptor, profile = SourcePolicy.PROFILES.default) {
        if (!descriptor || !descriptor.kind) {
            throw new Error("[SourceReader] Invalid source descriptor.");
        }

        const maxSizeBytes = profile.maxSizeBytes || 100 * 1024 * 1024;

        switch (descriptor.kind) {
            case "file":
                return this._readFile(descriptor, maxSizeBytes);

            case "base64":
                return this._readBase64(descriptor, maxSizeBytes);

            case "url":
                return this._readUrl(descriptor.value, profile);

            default:
                throw new Error(`[SourceReader] Cannot read source kind: "${descriptor.kind}".`);
        }
    }

    /**
     * Reads file buffer and checks size limit
     */
    static _readFile(descriptor, maxSizeBytes) {
        const buf = descriptor.buffer;
        if (!buf || !Buffer.isBuffer(buf)) {
            throw new Error("[SourceReader] Missing or invalid file buffer.");
        }

        if (buf.length > maxSizeBytes) {
            const maxMB = (maxSizeBytes / (1024 * 1024)).toFixed(1);
            const actualMB = (buf.length / (1024 * 1024)).toFixed(1);
            throw new Error(`[SourceReader] Uploaded file is too large (${actualMB}MB). Maximum allowed is ${maxMB}MB.`);
        }

        return {
            buffer: buf,
            sizeBytes: buf.length,
            originalName: descriptor.originalName || "upload.bin",
            mimeHint: descriptor.mimeHint || null,
        };
    }

    /**
     * Decodes Base64 data and checks size limit
     */
    static _readBase64(descriptor, maxSizeBytes) {
        const raw = descriptor.value || "";
        const pureBase64 = raw.includes(",") ? raw.split(",")[1] : raw;

        let buf;
        try {
            buf = Buffer.from(pureBase64, "base64");
        } catch (e) {
            throw new Error(`[SourceReader] Failed to decode base64 string: ${e.message}`);
        }

        if (!buf || buf.length === 0) {
            throw new Error("[SourceReader] Decoded base64 payload is empty.");
        }

        if (buf.length > maxSizeBytes) {
            const maxMB = (maxSizeBytes / (1024 * 1024)).toFixed(1);
            const actualMB = (buf.length / (1024 * 1024)).toFixed(1);
            throw new Error(`[SourceReader] Base64 payload is too large (${actualMB}MB). Maximum allowed is ${maxMB}MB.`);
        }

        return {
            buffer: buf,
            sizeBytes: buf.length,
            originalName: descriptor.originalName || "base64_upload.bin",
            mimeHint: descriptor.mimeHint || null,
        };
    }

    /**
     * Streams remote URL with redirect checks and byte-counting guard.
     */
    static async _readUrl(initialUrl, profile) {
        let currentUrl = initialUrl;
        const maxRedirects = 3;
        const maxSizeBytes = profile.maxSizeBytes;

        for (let hop = 0; hop <= maxRedirects; hop++) {
            // 1. Validate target URL against SSRF rules before making network call
            const validatedUrl = await SourcePolicy.validateUrl(currentUrl);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 25000); // 25s timeout

            let res;
            try {
                res = await fetch(validatedUrl.toString(), {
                    signal: controller.signal,
                    redirect: "manual",
                    headers: {
                        "User-Agent": "OpenArt-MediaIngestion/1.0",
                        Accept: "image/*,video/*;q=0.9,*/*;q=0.5",
                    },
                });
            } catch (err) {
                clearTimeout(timeout);
                if (err.name === "AbortError") {
                    throw new Error(`[SourceReader] Request to "${currentUrl}" timed out after 25 seconds.`);
                }
                throw new Error(`[SourceReader] Failed to fetch remote URL: ${err.message}`);
            }

            // 2. Handle HTTP Redirects manually to re-verify destination
            if ([301, 302, 303, 307, 308].includes(res.status)) {
                clearTimeout(timeout);
                const location = res.headers.get("location");
                if (!location) {
                    throw new Error(`[SourceReader] Redirect received without Location header from "${currentUrl}".`);
                }

                currentUrl = new URL(location, validatedUrl).toString();
                if (hop === maxRedirects) {
                    throw new Error(`[SourceReader] Too many redirects (maximum allowed: ${maxRedirects}).`);
                }
                continue;
            }

            // 3. Status Check
            if (!res.ok) {
                clearTimeout(timeout);
                throw new Error(`[SourceReader] Remote server responded with error ${res.status}: ${res.statusText}`);
            }

            // 4. Pre-check Content-Length header if provided
            const contentLengthHeader = res.headers.get("content-length");
            if (contentLengthHeader) {
                const declaredBytes = Number(contentLengthHeader);
                if (!isNaN(declaredBytes) && declaredBytes > maxSizeBytes) {
                    clearTimeout(timeout);
                    const maxMB = (maxSizeBytes / (1024 * 1024)).toFixed(1);
                    const actualMB = (declaredBytes / (1024 * 1024)).toFixed(1);
                    throw new Error(
                        `[SourceReader] Remote file size (${actualMB}MB) exceeds maximum limit (${maxMB}MB).`
                    );
                }
            }

            // 5. Stream chunks and enforce byte-counter guard
            const chunks = [];
            let totalBytes = 0;

            try {
                // Node 18+ fetch body is an async iterable / Web ReadableStream
                for await (const chunk of res.body) {
                    totalBytes += chunk.length;
                    if (totalBytes > maxSizeBytes) {
                        controller.abort();
                        const maxMB = (maxSizeBytes / (1024 * 1024)).toFixed(1);
                        throw new Error(
                            `[SourceReader] File stream exceeded maximum allowed size of ${maxMB}MB during download.`
                        );
                    }
                    chunks.push(Buffer.from(chunk));
                }
            } catch (streamErr) {
                clearTimeout(timeout);
                if (streamErr.name === "AbortError" && totalBytes > maxSizeBytes) {
                    const maxMB = (maxSizeBytes / (1024 * 1024)).toFixed(1);
                    throw new Error(`[SourceReader] File stream exceeded maximum allowed size of ${maxMB}MB during download.`);
                }
                throw streamErr;
            } finally {
                clearTimeout(timeout);
            }

            const buffer = Buffer.concat(chunks);
            const mimeHint = res.headers.get("content-type")?.split(";")[0]?.trim() || null;

            // Extract file name from URL pathname
            const pathname = validatedUrl.pathname;
            const originalName = pathname.substring(pathname.lastIndexOf("/") + 1) || "remote_media.bin";

            return {
                buffer,
                sizeBytes: buffer.length,
                originalName,
                mimeHint,
            };
        }

        throw new Error("[SourceReader] Failed to complete download.");
    }
}

export default SourceReader;
