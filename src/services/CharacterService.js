/**
 * CharacterService
 * Canonical owner of all character CRUD and character media orchestration.
 * Controllers become thin HTTP adapters; all character business logic lives here.
 *
 * Clean Architecture Boundary:
 *   - CharacterService manages Character entity operations (`characters` table).
 *   - Workflow deletion and media resource cleanup is strictly delegated to `WorkflowService`.
 *
 * Methods:
 *   - createCharacter
 *   - updateCharacter
 *   - addMediaToCharacter
 *   - removeMediaFromCharacter
 *   - deleteCharacter
 *
 * Feature: 024-unify-domain-crud
 * Contract: specs/024-unify-domain-crud/contracts/domain-crud-contract.md
 */

import { randomUUID } from "node:crypto";
import { supabase, supabaseAdmin } from "../../lib/supabase.js";
import { crudOperationLog, CrudServiceError } from "../utils/crudOperationLog.js";

export class CharacterService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db               - Repository map from container
     * @param {Object} deps.storageService   - StorageService instance
     * @param {Object} deps.workflowService  - WorkflowService instance
     */
    constructor({ db, storageService, workflowService }) {
        this.db               = db;
        this.storageService   = storageService;
        this.workflowService  = workflowService;
    }

    // ── createCharacter ──────────────────────────────────────────────────────

    async createCharacter({ projectId, userId, workflowId, name, description }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "createCharacter", projectId });

        try {
            if (!projectId) {
                throw new CrudServiceError("project_id is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "createCharacter",
                });
            }

            const characterId = workflowId || randomUUID();
            const charName    = name || "Untitled Character";

            const upsertPayload = {
                id:             characterId,
                workflow_id:    characterId,
                project_id:     projectId,
                user_id:        userId,
                name:           charName,
                title:          charName,
                description:    description || "",
                character_info: description || "",
                updated_at:     new Date().toISOString(),
            };

            const { data: char, error: charErr } = await supabaseAdmin
                .from("characters")
                .upsert(upsertPayload, { onConflict: "id" })
                .select()
                .maybeSingle();

            if (charErr) {
                console.warn(`⚠️ [CharacterService] createCharacter upsert notice:`, charErr.message);
            }

            // Explicitly ensure workflow_type in workflow table is set to "CHARACTER"
            if (characterId) {
                await supabaseAdmin
                    .from("workflow")
                    .update({ workflow_type: "CHARACTER" })
                    .eq("id", characterId);
            }

            crudOperationLog({
                traceId, operation: "createCharacter", status: "ok",
                durationMs: Date.now() - start, characterId,
            });

            return { characterId, workflowId: characterId, character: char };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "createCharacter", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── updateCharacter ──────────────────────────────────────────────────────

    async updateCharacter({ characterId, updates, userId }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "updateCharacter", characterId });

        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "updateCharacter",
                });
            }

            const charUpdates = { updated_at: new Date().toISOString() };
            const wfUpdates   = {};

            const nameVal = updates.name || updates.title || updates.display_name;
            if (nameVal !== undefined) {
                const cleanName = String(nameVal || "").replace(/^@+/, "").trim();
                if (cleanName.length > 0) {
                    charUpdates.name  = cleanName;
                    charUpdates.title = cleanName;
                    wfUpdates.display_name = cleanName;
                } else {
                    const { data: existingChar } = await supabaseAdmin
                        .from("characters")
                        .select("name, title")
                        .or(`id.eq.${characterId},workflow_id.eq.${characterId}`)
                        .maybeSingle();
                    const fallbackName = existingChar?.name || existingChar?.title || "Untitled Character";
                    charUpdates.name  = fallbackName;
                    charUpdates.title = fallbackName;
                    wfUpdates.display_name = fallbackName;
                }
            }

            const descVal = updates.description !== undefined ? updates.description : updates.character_info;
            if (descVal !== undefined) {
                const cleanDesc = String(descVal || "").trim();
                charUpdates.description    = cleanDesc;
                charUpdates.character_info = cleanDesc;
            }

            const turnaroundVal = updates.turnaround_url || updates.body_sheet_url;
            if (turnaroundVal !== undefined) charUpdates.turnaround_url = turnaroundVal;

            if (updates.avatar_url !== undefined) charUpdates.avatar_url = updates.avatar_url;

            if (updates.archetype !== undefined) charUpdates.archetype = updates.archetype;
            if (updates.gender !== undefined)    charUpdates.gender    = updates.gender;
            if (updates.style !== undefined)     charUpdates.style     = updates.style;

            if (updates.traits !== undefined)       charUpdates.traits     = updates.traits;
            if (updates.keywords !== undefined)     charUpdates.keywords   = updates.keywords;
            if (updates.guidelines !== undefined)   charUpdates.guidelines = updates.guidelines;
            if (updates.more_details !== undefined) {
                charUpdates.traits = { ...(charUpdates.traits || {}), more_details: updates.more_details };
            }

            if (updates.status !== undefined)       charUpdates.status       = updates.status;
            if (updates.is_favorited !== undefined) charUpdates.is_favorited = !!updates.is_favorited;
            if (updates.favorited !== undefined)    charUpdates.is_favorited = !!updates.favorited;

            let { data: updatedChar, error: charErr } = await supabaseAdmin
                .from("characters")
                .update(charUpdates)
                .or(`id.eq.${characterId},workflow_id.eq.${characterId}`)
                .select()
                .maybeSingle();

            if (charErr) {
                console.warn(`⚠️ [CharacterService] updateCharacter notice:`, charErr.message);
            }

            if (!updatedChar) {
                const { data: wfRow } = await supabaseAdmin
                    .from("workflow")
                    .select("id, project_id, user_id")
                    .eq("id", characterId)
                    .maybeSingle();

                const insertPayload = {
                    id:             characterId,
                    workflow_id:    characterId,
                    project_id:     wfRow?.project_id || null,
                    user_id:        userId || wfRow?.user_id || null,
                    name:           charUpdates.name  || "Untitled Character",
                    title:          charUpdates.title || "Untitled Character",
                    description:    charUpdates.description    || "",
                    character_info: charUpdates.character_info || "",
                    ...charUpdates,
                };

                const { data: insertedChar, error: insertErr } = await supabaseAdmin
                    .from("characters")
                    .upsert(insertPayload, { onConflict: "id" })
                    .select()
                    .maybeSingle();

                if (insertErr) {
                    console.warn(`⚠️ [CharacterService] upsert notice:`, insertErr.message);
                } else {
                    updatedChar = insertedChar;
                }
            }

            let updatedWf = null;
            if (Object.keys(wfUpdates).length > 0) {
                const { data: wfRes } = await supabaseAdmin
                    .from("workflow")
                    .update(wfUpdates)
                    .eq("id", characterId)
                    .select()
                    .maybeSingle();
                updatedWf = wfRes;
            }

            crudOperationLog({
                traceId, operation: "updateCharacter", status: "ok",
                durationMs: Date.now() - start, characterId,
            });

            return {
                character: updatedChar || { id: characterId, ...charUpdates },
                workflow:  updatedWf,
            };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "updateCharacter", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── addMediaToCharacter ──────────────────────────────────────────────────

    async addMediaToCharacter({ characterId, mediaId, imageUrl, projectId, userId }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "addMediaToCharacter", characterId });

        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "addMediaToCharacter",
                });
            }
            if (!mediaId && !imageUrl) {
                throw new CrudServiceError("Either mediaId or imageUrl is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "addMediaToCharacter",
                });
            }

            const { data: wf, error: wfErr } = await supabaseAdmin
                .from("workflow")
                .select("id, project_id")
                .eq("id", characterId)
                .maybeSingle();

            if (wfErr || !wf) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404, errorCode: "NOT_FOUND", traceId, operation: "addMediaToCharacter",
                });
            }

            let resolvedUrl    = imageUrl;
            let resolvedWidth  = 1024;
            let resolvedHeight = 1024;

            if (mediaId) {
                const { data: sourceMedia, error: sourceErr } = await supabaseAdmin
                    .from("media")
                    .select("*")
                    .eq("id", mediaId)
                    .maybeSingle();

                if (sourceErr || !sourceMedia) {
                    throw new CrudServiceError(`Media with ID ${mediaId} not found`, {
                        statusCode: 404, errorCode: "NOT_FOUND", traceId, operation: "addMediaToCharacter",
                    });
                }

                resolvedUrl    = sourceMedia.url;
                resolvedWidth  = sourceMedia.width  || 1024;
                resolvedHeight = sourceMedia.height || 1024;
            } else if (imageUrl && imageUrl.startsWith("data:")) {
                const newMediaId = randomUUID();
                const ext = imageUrl.startsWith("data:image/png")
                    ? "png"
                    : imageUrl.startsWith("data:image/webp")
                    ? "webp"
                    : "jpg";
                const storagePath = `character-details/${userId}/${characterId}/${newMediaId}.${ext}`;
                resolvedUrl = await this.storageService.upload(storagePath, imageUrl);
            }

            const newRecordId = randomUUID();
            const { data: mediaRow, error: mediaErr } = await supabaseAdmin
                .from("media")
                .insert({
                    id:          newRecordId,
                    workflow_id: wf.id,
                    project_id:  wf.project_id || projectId,
                    url:         resolvedUrl,
                    step_id:     "character_detail",
                    width:       resolvedWidth,
                    height:      resolvedHeight,
                    status:      "success",
                })
                .select()
                .single();

            if (mediaErr) {
                throw new CrudServiceError(mediaErr.message, {
                    statusCode: 500, errorCode: "DB_ERROR", traceId, operation: "addMediaToCharacter",
                });
            }

            crudOperationLog({
                traceId, operation: "addMediaToCharacter", status: "ok",
                durationMs: Date.now() - start, characterId, newMediaId: newRecordId,
            });

            return { media: { ...mediaRow, url: resolvedUrl } };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "addMediaToCharacter", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── removeMediaFromCharacter ─────────────────────────────────────────────

    async removeMediaFromCharacter({ characterId, mediaId, userId }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "removeMediaFromCharacter", characterId, mediaId });

        try {
            const { error } = await supabase
                .from("media")
                .delete()
                .eq("id", mediaId)
                .eq("workflow_id", characterId);

            if (error) {
                throw new CrudServiceError(error.message, {
                    statusCode: 500, errorCode: "DB_ERROR", traceId, operation: "removeMediaFromCharacter",
                });
            }

            crudOperationLog({
                traceId, operation: "removeMediaFromCharacter", status: "ok",
                durationMs: Date.now() - start, characterId, mediaId,
            });

            return { ok: true };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "removeMediaFromCharacter", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }

    // ── deleteCharacter ──────────────────────────────────────────────────────

    /**
     * Delete a character entity and delegate all underlying workflow/media
     * resource cleanup to WorkflowService.
     */
    async deleteCharacter({ characterId, userId, req = null }) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "deleteCharacter", characterId });

        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400, errorCode: "VALIDATION_ERROR", traceId, operation: "deleteCharacter",
                });
            }

            // 1. Delete character domain record from public.characters
            const { error: charDeleteErr } = await supabaseAdmin
                .from("characters")
                .delete()
                .or(`id.eq.${characterId},workflow_id.eq.${characterId}`);

            if (charDeleteErr) {
                console.warn(`⚠️ [CharacterService] deleteCharacter characters row notice:`, charDeleteErr.message);
            }

            // 2. Delegate workflow/media resources cleanup directly to WorkflowService
            const result = await this.workflowService.deleteWorkflow({ workflowId: characterId, userId, req });

            crudOperationLog({
                traceId, operation: "deleteCharacter", status: "ok",
                durationMs: Date.now() - start, characterId,
            });

            return result;
        } catch (err) {
            crudOperationLog({
                traceId, operation: "deleteCharacter", status: "error",
                durationMs: Date.now() - start, errorCode: err.errorCode || 500, message: err.message,
            });
            throw err;
        }
    }
}

export default CharacterService;
