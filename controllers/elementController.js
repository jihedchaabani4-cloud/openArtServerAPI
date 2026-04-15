import { elementRepository } from "../src/db/ElementRepository.js";
import { storageService } from "../src/container.js";

/**
 * listElements - GET /api/elements
 */
export const listElements = async (req, res) => {
    try {
        const { type, search } = req.query;
        const elements = await elementRepository.list({ type, search });
        res.json({ ok: true, data: elements });
    } catch (err) {
        console.error("❌ List elements error:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * getElement - GET /api/elements/:idOrSlug
 */
export const getElement = async (req, res) => {
    try {
        const { idOrSlug } = req.params;
        let element;
        
        // Check if it's a UUID or a slug
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
        
        if (isUuid) {
            element = await elementRepository.findById(idOrSlug);
        } else {
            element = await elementRepository.findBySlug(idOrSlug);
        }

        if (!element) {
            return res.status(404).json({ ok: false, message: "Element not found" });
        }

        res.json({ ok: true, data: element });
    } catch (err) {
        console.error("❌ Get element error:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * uploadElementImages - Internal helper to upload base64 images to storage
 */
const uploadElementImages = async (slug, images) => {
    if (!images || !Array.isArray(images) || images.length === 0) return [];
    
    const uploadPromises = images.map(async (base64, index) => {
        // Only upload if it's base64, otherwise keep existing URL
        if (base64.startsWith('data:image')) {
            const path = `elements/${slug}/${Date.now()}_${index}.png`;
            return await storageService.upload(path, base64);
        }
        return base64;
    });

    return Promise.all(uploadPromises);
};

/**
 * createElement - POST /api/elements
 */
export const createElement = async (req, res) => {
    try {
        const { slug, display_name, type, description, visual_notes, reference_images, thumbnail_url } = req.body;

        if (!slug || !type) {
            return res.status(400).json({ ok: false, message: "Slug and type are required" });
        }

        // Check if slug already exists
        const existing = await elementRepository.findBySlug(slug);
        if (existing) {
            return res.status(400).json({ ok: false, message: `Slug '@${slug}' is already taken` });
        }

        // Handle Image Uploads if provided
        let imageUrls = [];
        if (reference_images && reference_images.length > 0) {
            console.log(`📸 [Elements] Uploading ${reference_images.length} images for @${slug}...`);
            imageUrls = await uploadElementImages(slug, reference_images);
        }

        const newElement = await elementRepository.create({
            slug,
            display_name: display_name || slug,
            type,
            description,
            visual_notes,
            reference_images: imageUrls,
            thumbnail_url: thumbnail_url || (imageUrls.length > 0 ? imageUrls[0] : null)
        });

        res.status(201).json({ ok: true, data: newElement });
    } catch (err) {
        console.error("❌ Create element error:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * updateElement - PATCH /api/elements/:id
 */
export const updateElement = async (req, res) => {
    try {
        const { id } = req.params;
        const { reference_images, ...otherUpdates } = req.body;

        const current = await elementRepository.findById(id);
        if (!current) return res.status(404).json({ ok: false, message: "Element not found" });

        let finalImages = reference_images;
        if (reference_images && Array.isArray(reference_images)) {
            finalImages = await uploadElementImages(current.slug, reference_images);
        }

        const updated = await elementRepository.update(id, {
            ...otherUpdates,
            ...(finalImages && { reference_images: finalImages })
        });
        
        res.json({ ok: true, data: updated });
    } catch (err) {
        console.error("❌ Update element error:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * deleteElement - DELETE /api/elements/:id
 */
export const deleteElement = async (req, res) => {
    try {
        const { id } = req.params;
        await elementRepository.delete(id);
        res.json({ ok: true, message: "Element deleted successfully" });
    } catch (err) {
        console.error("❌ Delete element error:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};
