/**
 * Read-only media status helpers.
 *
 * Mutating status transitions now live in
 * `src/services/MediaWorkflowLifecycleService.js`.
 */
import { isProcessing, isSuccess, isCompleted } from "./statusConstants.js";

// ── Idempotence / skip helpers ───────────────────────────────────

/**
 * Si un média est déjà en status=success avec une URL, on skippe
 * le re-call provider (évite le double spend API en cas de retry BullMQ).
 *
 * @returns {{fileUrl:string, mediaId:string, skippedDuplicate:true}|null}
 */
export async function skipIfMediaAlreadyDone(db, mediaId) {
  if (!mediaId) return null;
  const row = await db.media.findById(mediaId);
  if (isSuccess(row?.status) && row?.url) {
    return {
      fileUrl: row.url,
      mediaId,
      skippedDuplicate: true,
    };
  }
  return null;
}

/**
 * Version batch : skip seulement si TOUS les médias sont déjà faits.
 */
export async function skipIfAllMediaAlreadyDone(db, mediaIds) {
  if (!mediaIds?.length) return null;
  for (const mediaId of mediaIds) {
    const row = await db.media.findById(mediaId);
    if (!(isSuccess(row?.status) && row?.url)) return null;
  }
  return {
    skippedDuplicate: true,
    succeeded: mediaIds.length,
    failed: 0,
  };
}

// ── Read-only checkers ───────────────────────────────────────────

/** Vérifie si un média est prêt à être utilisé (success + url). */
export async function isMediaReady(db, mediaId) {
  if (!mediaId) return false;
  const row = await db.media.findById(mediaId);
  return isCompleted(row?.status, !!row?.url);
}

/** Vérifie si un média est encore en traitement. */
export async function isMediaProcessing(db, mediaId) {
  if (!mediaId) return false;
  const row = await db.media.findById(mediaId);
  return isProcessing(row?.status);
}
