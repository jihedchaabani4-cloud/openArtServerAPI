/**
 * SourceResolver
 * Classifies raw external source input into an internal descriptor.
 * Zero side-effects: does not perform network calls, uploads, or DB queries.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SourceResolver {
    /**
     * Inspects the input and returns a normalized source descriptor.
     *
     * @param {any} source - Input from user, multipart file, string URL, base64, or UUID
     * @returns {{
     *   kind: "media_id" | "url" | "base64" | "file",
     *   value?: string,
     *   buffer?: Buffer,
     *   originalName?: string,
     *   mimeHint?: string | null
     * }}
     */
    static resolve(source) {
        if (!source) {
            throw new Error("[SourceResolver] Source is required and cannot be empty.");
        }

        // 1. Multer file object (has buffer)
        if (typeof source === "object" && Buffer.isBuffer(source.buffer)) {
            return {
                kind: "file",
                buffer: source.buffer,
                originalName: source.originalname || "upload.bin",
                mimeHint: source.mimetype || null,
                sizeBytes: source.size || source.buffer.length,
            };
        }

        // 2. Raw Buffer
        if (Buffer.isBuffer(source)) {
            return {
                kind: "file",
                buffer: source,
                originalName: "upload.bin",
                mimeHint: null,
                sizeBytes: source.length,
            };
        }

        // 3. String inputs
        if (typeof source === "string") {
            const trimmed = source.trim();

            if (!trimmed) {
                throw new Error("[SourceResolver] Source string cannot be whitespace-only.");
            }

            // A: Existing Media ID (UUID)
            if (UUID_REGEX.test(trimmed)) {
                return {
                    kind: "media_id",
                    value: trimmed,
                };
            }

            // B: HTTP/HTTPS URL
            if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                return {
                    kind: "url",
                    value: trimmed,
                };
            }

            // C: Data URI (Base64)
            if (trimmed.startsWith("data:")) {
                const mimeMatch = trimmed.match(/^data:([^;]+);base64,/i);
                return {
                    kind: "base64",
                    value: trimmed,
                    mimeHint: mimeMatch ? mimeMatch[1].toLowerCase() : null,
                };
            }

            // D: Raw base64 string (longer than 100 characters with no spaces)
            if (trimmed.length > 100 && !/\s/.test(trimmed)) {
                return {
                    kind: "base64",
                    value: trimmed,
                    mimeHint: null,
                };
            }
        }

        throw new Error(
            "[SourceResolver] Unsupported source format. Expected file buffer, HTTP(S) URL, Base64 data URI, or UUID."
        );
    }
}

export default SourceResolver;
