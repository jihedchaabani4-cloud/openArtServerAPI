import { deleteOne, updateOne } from "../lib/supabaseCrud.js";
import { supabase } from "../lib/supabase.js";

// In the new schema:
// A "generation group" is a `generation`.
// An "item" is a `collection_item` pointing to a `media`.

export const deleteGeneration = async (req, res) => {
    try {
        await deleteOne("generations", req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

export const deleteItem = async (req, res) => {
    try {
        // Assume req.params.id is the collection_item id.
        await deleteOne("collection_items", req.params.id);
        res.json({ ok: true });
    } catch (error) {
        console.error("❌ deleteItem error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

export const updateGeneration = async (req, res) => {
    try {
        const data = await updateOne("generations", req.params.id, req.body);
        res.json({ ok: true, data });
    } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
    }
};

export const toggleLike = async (req, res) => {
    try {
        // The new schema doesn't have `is_liked` natively. 
        // A common pattern is storing it in `metadata` on `media_versions` or we skip it if it's not strictly specified in the new schema yet.
        // As a placeholder, we return OK to not break the frontend until the schema natively supports favorites.
        res.json({ ok: true, note: "is_liked not natively supported in new schema yet." });
    } catch (error) {
        console.error("❌ toggleLike error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
