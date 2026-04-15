export async function uploadReferenceAssetToStorage({
    storageService,
    db,
    base64,
    userId,
    project_id,
    session_id,
    role,
}) {
    const fileName = `${userId}/uploads/${Date.now()}.jpg`;
    const fileUrl = await storageService.upload(fileName, base64);

    const asset = await db.createAsset({
        project_id,
        session_id,
        userId,
        asset_type: "uploaded",
        media_type: "image",
        file_url: fileUrl,
        file_path: fileName,
        mime_type: "image/jpeg",
    });

    return {
        role,
        type: "image_url",
        url: fileUrl,
        asset_id: asset.id,
    };
}
