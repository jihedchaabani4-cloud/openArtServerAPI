export function detectMode(references) {
    if (!references?.length)
        return "t2v";

    const hasVideo = references.some(r => (r.role === "video" || r.role === "mc_video") && (r.type === "video" || r.type === "video_url" || r.url?.includes(".mp4")));
    const hasStart = references.some(r => r.role === "start" || r.role === "normal" || r.role === "mc_image");
    const hasEnd   = references.some(r => r.role === "end");

    if (hasVideo) {
        // For Runway Gen-4 Aleph, we want v2v mode
        // But for Kling, it's often motion. 
        // We'll let the router decide but return a generic 'video' hint if possible
        // For now, let's just return v2v if it's a plain video upload
        return "v2v";
    }
    if (hasStart && hasEnd)    return "i2v_se";
    if (hasEnd)                return "i2v_se";
    if (references.length > 1 || references.some(r => r.name))
        return "r2v";
    return "i2v";
}
