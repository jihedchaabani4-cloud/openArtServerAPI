/**
 * ╔═══════════════════════════════════════════════════════════════╗
 *  mediaValidation.js  –  Guards & validation pour les médias
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Regroupe toutes les fonctions de validation côté serveur:
 *   • Vérifier qu'un média est utilisable (edit/upscale/ref)
 *   • Vérifier les droits d'accès (workflow/project/session)
 */

import { db } from "../container.js";
import { isCompleted, isProcessing } from "./statusConstants.js";

/**
 * Server-side guard pour s'assurer qu'un média peut être utilisé comme input
 * (edit / upscale / set primary / reference dans les workflows).
 *
 * Rules:
 *   - Le média doit exister
 *   - Le média doit être complété et avoir une URL
 *   - Si workflow_id est fourni, le média doit appartenir à ce workflow
 *   - Si project_id est fourni, le média doit appartenir à ce project
 *   - Si session_id est fourni, le workflow du média doit appartenir à cette session
 *
 * @param {Object}  selectors
 * @param {string}  [selectors.media_id]
 * @param {string}  [selectors.workflow_id]
 * @param {string}  [selectors.project_id]
 * @param {string}  [selectors.session_id]
 * @param {Object}  [options]
 * @param {boolean} [options.allowProcessing=false]  – autoriser les médias en processing ?
 * @returns {Promise<Object>} le media row validé
 * @throws {Error} 400/403/404 avec .statusCode
 */
export async function assertMediaUsable(
  { media_id, workflow_id = null, project_id = null, session_id = null },
  options = {}
) {
  const { allowProcessing = false } = options;

  let targetMediaId = media_id;

  // Si pas de media_id mais workflow_id → résoudre via primary media
  if (!targetMediaId && workflow_id) {
    const primary = await db.workflows.getPrimaryMedia(workflow_id);
    if (primary?.id) targetMediaId = primary.id;
  }

  if (!targetMediaId) {
    const err = new Error("media_id or workflow_id is required to resolve media");
    err.statusCode = 400;
    throw err;
  }

  const media = await db.media.findWithContext(targetMediaId);
  if (!media) {
    const err = new Error("Media not found");
    err.statusCode = 404;
    throw err;
  }

  const status = (media.status || "").toString().toLowerCase();
  const hasUrl = !!media.url;
  const processing = isProcessing(status);
  const rejected   = ["rejected", "failed", "error"].includes(status);
  const completed  = isCompleted(status, hasUrl);

  if (!completed) {
    if (!(allowProcessing && processing)) {
      const err = new Error("Media is not completed yet");
      err.statusCode = 403;
      throw err;
    }
  }

  if (workflow_id && media.workflow_id !== workflow_id) {
    const err = new Error("Media does not belong to this workflow");
    err.statusCode = 403;
    throw err;
  }

  if (project_id && media.project_id !== project_id) {
    const err = new Error("Media does not belong to this project");
    err.statusCode = 403;
    throw err;
  }

  const wfSessionId = media.workflow?.session_id ?? null;
  if (session_id && wfSessionId && wfSessionId !== session_id) {
    const err = new Error("Media does not belong to this session");
    err.statusCode = 403;
    throw err;
  }

  return media;
}

/**
 * Version light : vérifie juste l'existence + complétion sans ownership.
 */
export async function assertMediaReady(mediaId) {
  if (!mediaId) {
    const err = new Error("media_id is required");
    err.statusCode = 400;
    throw err;
  }
  const media = await db.media.findById(mediaId);
  if (!media) {
    const err = new Error("Media not found");
    err.statusCode = 404;
    throw err;
  }
  if (!isCompleted(media.status, !!media.url)) {
    const err = new Error("Media is not ready");
    err.statusCode = 403;
    throw err;
  }
  return media;
}
