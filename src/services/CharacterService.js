/**
 * CharacterService
 * Canonical owner of all character CRUD and character media orchestration.
 * Controllers become thin HTTP adapters; all character business logic lives here.
 *
 * Clean Architecture Boundary:
 *   - CharacterService manages Character entity operations (`characters` table)
 *     via CharacterRepository (db.characters).
 *   - Workflow/media reads delegate to WorkflowRepository (db.workflows) and
 *     MediaRepository (db.media).
 *   - Project lookups delegate to ProjectRepository (db.projects).
 *   - Storage uploads delegate to StorageService.
 *   - Workflow deletion and media resource cleanup delegate to WorkflowService.
 *   - LLM description generation delegates to LLMService.
 *
 * NO direct supabase / supabaseAdmin calls in this service.
 *
 * Methods:
 *   - createCharacter
 *   - updateCharacter
 *   - addMediaToCharacter
 *   - removeMediaFromCharacter
 *   - deleteCharacter
 *   - generateDescription
 *
 * Feature: 024-unify-domain-crud
 * Contract: specs/024-unify-domain-crud/contracts/domain-crud-contract.md
 */

import { randomUUID } from "node:crypto";
import { llmService } from "./LLMService.js";
import { crudOperationLog, CrudServiceError } from "../utils/crudOperationLog.js";

// ── LLM prompt (moved from characterController) ───────────────────────────────

const CHARACTER_GENERATOR_SYSTEM_PROMPT = `
You are an elite haute-couture AI Art Director and Master Character Designer for high-budget cinematic films and editorial fashion houses.
Your task: Given a character concept, archetype, or brief description (such as "The Eccentric", "The Botanical Visionary", "The Wicked", or a custom user prompt), generate an ultra-rich, highly descriptive, editorial character description.

Focus heavily on:
1. Facial geometry, anatomical features, skin texture, and unique biological/sub-dermal details.
2. Architectural hair/headpiece design and editorial posture.
3. Outfit materials, structural tailoring, fabrics (waxy leaves, felted wool, translucent fibers, wet-look surfaces).
4. Cinematic lighting, color mood, and authoritative visual presence.

CRITICAL OUTPUT REQUIREMENT:
You MUST return your response as a valid JSON object with this schema:
{
  "title": "A short 2-4 word evocative character name/title",
  "description": "A 3-5 sentence ultra-detailed, editorial character description ready for high-end AI generation.",
  "keywords": ["5-10 concise factual visual identity keywords"]
}
Do NOT include any markdown code blocks or extra text outside the JSON object.
`;

// ─────────────────────────────────────────────────────────────────────────────

export class CharacterService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db               - Repository map from container
     *                                         (db.characters, db.workflows, db.media, db.projects)
     * @param {Object} deps.storageService   - StorageService instance
     * @param {Object} deps.workflowService  - WorkflowService instance
     */
    constructor({ db, storageService, workflowService }) {
        this.db              = db;
        this.storageService  = storageService;
        this.workflowService = workflowService;
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

            // Resolve userId — fall back to project owner if userId is not a valid UUID
            const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            let safeUserId = userId;
            if (!safeUserId || !UUID_REGEX.test(safeUserId)) {
                const proj = await this.db.projects.findById(projectId).catch(() => null);
                if (proj?.user_id) safeUserId = proj.user_id;
            }

            const upsertPayload = {
                id:             characterId,
                workflow_id:    characterId,
                project_id:     projectId,
                user_id:        safeUserId,
                name:           charName,
                title:          charName,
                description:    description || "",
                character_info: description || "",
                updated_at:     new Date().toISOString(),
            };

            // Upsert character row via repository (bypasses RLS via admin client)
            let char = await this.db.characters.upsert(upsertPayload).catch(async (err) => {
                console.warn(`⚠️ [CharacterService] createCharacter upsert notice:`, err.message);
                // Fallback: re-try with confirmed project owner's user_id
                const proj = await this.db.projects.findById(projectId).catch(() => null);
                if (proj?.user_id && proj.user_id !== safeUserId) {
                    upsertPayload.user_id = proj.user_id;
                    return this.db.characters.upsert(upsertPayload).catch((retryErr) => {
                        console.error(`❌ [CharacterService] createCharacter fallback failed:`, retryErr.message);
                        return null;
                    });
                }
                return null;
            });

            // Sync display_name on the workflow container
            if (characterId && charName) {
                await this.db.workflows.updateFields(characterId, { display_name: charName }).catch(() => null);
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
                    // Preserve existing name if empty string provided
                    const existingChar = await this.db.characters.findByCharacterId(characterId).catch(() => null);
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

            if (updates.avatar_url !== undefined)  charUpdates.avatar_url  = updates.avatar_url;
            if (updates.archetype  !== undefined)  charUpdates.archetype   = updates.archetype;
            if (updates.gender     !== undefined)  charUpdates.gender      = updates.gender;
            if (updates.style      !== undefined)  charUpdates.style       = updates.style;

            if (updates.traits     !== undefined)  charUpdates.traits      = updates.traits;
            if (updates.keywords   !== undefined)  charUpdates.keywords    = updates.keywords;
            if (updates.guidelines !== undefined)  charUpdates.guidelines  = updates.guidelines;
            if (updates.more_details !== undefined) {
                charUpdates.traits = { ...(charUpdates.traits || {}), more_details: updates.more_details };
            }

            if (updates.status       !== undefined) charUpdates.status       = updates.status;
            if (updates.is_favorited !== undefined) charUpdates.is_favorited = !!updates.is_favorited;
            if (updates.favorited    !== undefined) charUpdates.is_favorited = !!updates.favorited;

            // Try update first; if no row found, upsert with workflow context
            let updatedChar = await this.db.characters.updateCharacterFields(characterId, charUpdates).catch((err) => {
                console.warn(`⚠️ [CharacterService] updateCharacter notice:`, err.message);
                return null;
            });

            if (!updatedChar) {
                // Character row may not exist yet — resolve from workflow and upsert
                const wfRow = await this.db.workflows.getWorkflow(characterId).catch(() => null);

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

                updatedChar = await this.db.characters.upsert(insertPayload).catch((insertErr) => {
                    console.warn(`⚠️ [CharacterService] upsert notice:`, insertErr.message);
                    return null;
                });
            }

            let updatedWf = null;
            if (Object.keys(wfUpdates).length > 0) {
                updatedWf = await this.db.workflows.updateFields(characterId, wfUpdates).catch(() => null);
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

            // Verify the character's workflow container exists
            const wf = await this.db.workflows.getWorkflow(characterId).catch(() => null);
            if (!wf) {
                throw new CrudServiceError("Character workflow not found", {
                    statusCode: 404, errorCode: "NOT_FOUND", traceId, operation: "addMediaToCharacter",
                });
            }

            let resolvedUrl    = imageUrl;
            let resolvedWidth  = 1024;
            let resolvedHeight = 1024;

            if (mediaId) {
                // Resolve dimensions/URL from existing media record
                const sourceMedia = await this.db.media.findById(mediaId).catch(() => null);
                if (!sourceMedia) {
                    throw new CrudServiceError(`Media with ID ${mediaId} not found`, {
                        statusCode: 404, errorCode: "NOT_FOUND", traceId, operation: "addMediaToCharacter",
                    });
                }
                resolvedUrl    = sourceMedia.url;
                resolvedWidth  = sourceMedia.width  || 1024;
                resolvedHeight = sourceMedia.height || 1024;
            } else if (imageUrl && imageUrl.startsWith("data:")) {
                // Upload base64 data URI to storage
                const newMediaId = randomUUID();
                const ext = imageUrl.startsWith("data:image/png")
                    ? "png"
                    : imageUrl.startsWith("data:image/webp")
                    ? "webp"
                    : "jpg";
                const storagePath = `character-details/${userId}/${characterId}/${newMediaId}.${ext}`;
                resolvedUrl = await this.storageService.upload(storagePath, imageUrl);
            }

            // Create the media record via repository
            const mediaRow = await this.db.media.createMedia({
                workflow_id: wf.id,
                project_id:  wf.project_id || projectId,
                url:         resolvedUrl,
                step_id:     "character_detail",
                width:       resolvedWidth,
                height:      resolvedHeight,
                status:      "success",
            });

            crudOperationLog({
                traceId, operation: "addMediaToCharacter", status: "ok",
                durationMs: Date.now() - start, characterId, newMediaId: mediaRow.id,
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
            // Scoped delete — only removes media if it belongs to this character's workflow
            await this.db.media.deleteByIdAndWorkflow(mediaId, characterId);

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

            // 1. Delete character domain record via repository
            await this.db.characters.deleteById(characterId).catch((charDeleteErr) => {
                console.warn(`⚠️ [CharacterService] deleteCharacter characters row notice:`, charDeleteErr.message);
            });

            // 2. Delegate workflow/media resources cleanup to WorkflowService
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

    // ── generateDescription ──────────────────────────────────────────────────

    /**
     * Generates an ultra-detailed, editorial character description from a brief concept.
     * Uses LLMService (Gemini → Groq fallback) with a haute-couture art direction prompt.
     *
     * @param {Object} params
     * @param {string} [params.concept]   - Free-form character concept
     * @param {string} [params.archetype] - Character archetype
     * @param {string} [params.style]     - Style influences
     * @returns {{ title, description, keywords, model }}
     */
    async generateDescription({ concept, archetype, style } = {}) {
        const traceId = randomUUID();
        const start   = Date.now();

        crudOperationLog({ traceId, operation: "generateDescription" });

        try {
            const inputConcept = concept || archetype || "The Eccentric";
            const promptText = `Generate a masterwork character description for the concept: "${inputConcept}". ${
                style ? `Incorporate style influences: ${style}.` : ""
            }`;

            const result = await llmService.generate({
                prompt: promptText,
                systemInstruction: CHARACTER_GENERATOR_SYSTEM_PROMPT,
                jsonMode: true,
            });

            const parsed      = result.json || {};
            const description = parsed.description || result.raw || "A visionary character with striking anatomical features and high-fashion editorial presence.";
            const title       = parsed.title || inputConcept;
            const keywords    = Array.isArray(parsed.keywords) ? parsed.keywords : [];

            crudOperationLog({
                traceId, operation: "generateDescription", status: "ok",
                durationMs: Date.now() - start,
            });

            return { title, description, keywords, model: result.model };
        } catch (err) {
            crudOperationLog({
                traceId, operation: "generateDescription", status: "error",
                durationMs: Date.now() - start, message: err.message,
            });
            throw err;
        }
    }
}

export default CharacterService;
