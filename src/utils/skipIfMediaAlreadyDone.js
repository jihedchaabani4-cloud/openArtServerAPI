/**
 * BullMQ may retry a job after a crash/stalled recovery. If we already wrote the
 * final asset + success status, skip re-calling the provider (avoids double API spend).
 *
 * Call `walletService.commitHoldIdempotent` on the skip path so a prior crash
 * after DB success but before commit still finalizes the hold.
 */
export async function skipIfMediaAlreadyDone(db, mediaId) {
  if (!mediaId) return null;
  const row = await db.media.findById(mediaId);
  if (row?.status === "success" && row?.url) {
    return {
      fileUrl: row.url,
      mediaId,
      skippedDuplicate: true,
    };
  }
  return null;
}

/** Multi-variation generate: skip only when every placeholder media row is already done. */
export async function skipIfAllMediaAlreadyDone(db, mediaIds) {
  if (!mediaIds?.length) return null;
  for (const mediaId of mediaIds) {
    const row = await db.media.findById(mediaId);
    if (!(row?.status === "success" && row?.url)) return null;
  }
  return {
    skippedDuplicate: true,
    succeeded: mediaIds.length,
    failed: 0,
  };
}
