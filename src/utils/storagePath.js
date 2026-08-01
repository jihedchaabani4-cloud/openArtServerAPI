/**
 * Extract storage bucket path from a Supabase public URL.
 */
export function extractStoragePath(url) {
    if (!url || typeof url !== "string") return null;
    const parts = url.split("/public/");
    if (parts.length > 1) {
        const subParts = parts[1].split("/");
        return subParts.slice(1).join("/");
    }
    return null;
}
