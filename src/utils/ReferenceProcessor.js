/**
 * ReferenceProcessor
 * Transforms raw references from the frontend into structured input_assets.
 * In the new schema, asset_id = media.id (not media_versions.id).
 */
export class ReferenceProcessor {
    constructor({ storageService, db }) {
        this.storageService = storageService;
        this.db = db;
    }


    _normalizeRole(rawRole) {
        if (!rawRole) return "reference";
        switch (rawRole) {
            case "IMAGE_INPUT_TYPE_BASE_IMAGE": return "source";
            case "IMAGE_INPUT_TYPE_REFERENCE":  return "reference";
            default: return rawRole;
        }
    }

    /**
     * @param {Array}  references   - Raw references from the frontend
     * @param {string} userId
     * @param {string} project_id
     * @param {string} session_id
     * @param {string} storageFolder
     * @returns {Array} input_assets — each item: { role, type, url, media_id?, is_base? }
     */
    async process(references, userId, project_id, session_id, storageFolder = "uploads") {
        const validRefs = (references || []).filter(ref =>
            ref.asset_id || ref.media_id || ref.url || ref.file || ref.api_url || ref.entity_id
        );

        const input_assets = await Promise.all(validRefs.map(async (ref, i) => {
            // ✅ Normalize role before anything else
            const role     = this._normalizeRole(ref.role);
            const media_id = ref.media_id || ref.asset_id || ref.id || null;
            const url      = ref.url || ref.api_url || null;
            const file     = ref.file || null;

            console.log(`🔍 [ReferenceProcessor] Ref [${i}]: role=${role} (raw=${ref.role})`, media_id ? "has media_id" : (url ? "has url" : "other"));

            // Case 1: Base64 — not supported, must upload first
            if (file || (typeof url === "string" && url.startsWith("data:"))) {
                throw new Error(`[ReferenceProcessor] Base64 uploads not allowed during generation. Upload first via /api/assets/upload.`);
            }

            // ✅ is_base: check normalized role
            const is_base = role === "source" || ref.is_base === true;

            // Case 2: Existing media (generated or uploaded)
            if (media_id) {
                let finalUrl = url;
                if (!finalUrl) {
                    const media = await this.db.media.findById(media_id);
                    finalUrl    = media?.url || null;
                }

                if (!finalUrl) {
                    console.warn(`⚠️ [ReferenceProcessor] No URL found for media_id: ${media_id}`);
                }

                const outType = (ref.type === "video" || ref.type === "video_url") ? "video_url" : "image_url";

                return {
                    role,
                    type:     outType,
                    url:      finalUrl,
                    media_id,
                    is_base,
                };
            }

            // Case 3: External / public URL — no media_id, log warning
            if (url) {
                // 🔍 Try to resolve media_id from URL if it's our storage
                const existingMedia = await this.db.media.findByUrl(url);
                if (existingMedia) {
                    console.log(`✨ [ReferenceProcessor] Ref [${i}] Resolved media_id: ${existingMedia.id} from URL`);
                    const outType = (ref.type === "video" || ref.type === "video_url") ? "video_url" : "image_url";
                    return {
                        role,
                        type:     outType,
                        url,
                        media_id: existingMedia.id,
                        is_base,
                    };
                }

                console.warn(`⚠️ [ReferenceProcessor] Ref [${i}] has external URL with no media_id record (will not track in generation references).`);
                const outType = (ref.type === "video" || ref.type === "video_url") ? "video_url" : "image_url";
                return {
                    role,
                    type:     outType,
                    url,
                    media_id: null,
                    is_base,
                };
            }

            // Case 4: Entity reference (character/product/location)
            if (ref.entity_id) {
                return {
                    role,
                    type:        "entity",
                    entity_id:   ref.entity_id,
                    entity_type: ref.entity_type,
                    media_id:    null,
                };
            }

            throw new Error(`[ReferenceProcessor] Invalid reference structure: ${JSON.stringify(ref)}`);
        }));

        this.validate(input_assets);
        return input_assets;
    }

    validate(input_assets) {
        // ✅ validRoles يشمل كل الـ formats المحتملة
        const validRoles = [
            // Internal roles
            "source", "style", "mask", "character", "location",
            "product", "reference", "normal", "start", "end",
            "video", "mc_video", "mc_image",
            // Google Labs format (بعد الـ normalize ما المفروض توصل هنا، لكن كـ safety net)
            "IMAGE_INPUT_TYPE_BASE_IMAGE", "IMAGE_INPUT_TYPE_REFERENCE",
        ];
        const validTypes = ["image_url", "video_url", "entity"];

        input_assets.forEach((ref, i) => {
            if (!validRoles.includes(ref.role))
                throw new Error(`Ref[${i}]: invalid role "${ref.role}"`);

            if (!validTypes.includes(ref.type))
                throw new Error(`Ref[${i}]: invalid type "${ref.type}"`);

            if ((ref.type === "image_url" || ref.type === "video_url") && !ref.url)
                throw new Error(`Ref[${i}]: ${ref.type} requires url`);

            if (ref.type === "entity" && !ref.entity_id)
                throw new Error(`Ref[${i}]: entity requires entity_id`);

            if (ref.type === "entity" && !ref.entity_type)
                throw new Error(`Ref[${i}]: entity requires entity_type`);
        });
    }
}
