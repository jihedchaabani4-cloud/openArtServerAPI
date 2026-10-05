/**
 * createSizeLimitedMemoryStorage
 *
 * Multer storage engine that limits in-memory buffering per media type:
 * - If file.mimetype indicates an image, buffering is aborted and rejected
 *   immediately if size exceeds imageLimit (default 20MB).
 * - If file.mimetype indicates a video, allows up to videoLimit (default 100MB).
 * - Prevents buffering 100MB of oversized image data into RAM before rejecting.
 */
export function createSizeLimitedMemoryStorage({
    imageLimit = 20 * 1024 * 1024,
    videoLimit = 100 * 1024 * 1024,
    defaultLimit = 20 * 1024 * 1024,
} = {}) {
    return {
        _handleFile(req, file, cb) {
            const isVideo = file.mimetype.startsWith("video/");
            const isImage = file.mimetype.startsWith("image/");
            const maxBytes = isVideo ? videoLimit : (isImage ? imageLimit : defaultLimit);

            const chunks = [];
            let totalBytes = 0;
            let aborted = false;

            file.stream.on("data", (chunk) => {
                if (aborted) return;
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    aborted = true;
                    file.stream.pause();
                    file.stream.destroy();
                    const err = new Error(
                        isImage
                            ? "Image file exceeds maximum allowed size of 20MB"
                            : "Uploaded file exceeds maximum allowed size"
                    );
                    err.code = "LIMIT_FILE_SIZE";
                    err.statusCode = 413;
                    return cb(err);
                }
                chunks.push(chunk);
            });

            file.stream.on("end", () => {
                if (aborted) return;
                const buffer = Buffer.concat(chunks, totalBytes);
                cb(null, {
                    buffer,
                    size: totalBytes,
                });
            });

            file.stream.on("error", (err) => {
                if (!aborted) {
                    cb(err);
                }
            });
        },

        _removeFile(req, file, cb) {
            delete file.buffer;
            cb(null);
        },
    };
}
