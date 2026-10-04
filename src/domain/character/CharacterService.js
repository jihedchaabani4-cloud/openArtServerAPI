/**
 * CharacterService
 * Canonical owner of all Character entity operations, lifecycle, and domain orchestration.
 *
 * Clean Architecture Boundary:
 *   - CharacterMediaService handles storage uploads, Supabase buckets, and media rows.
 *   - CharacterGenerationService handles AI UseCase job dispatching and LLM descriptions.
 *   - WorkflowService handles workflow lifecycle and low-level workflow deletion.
 *   - CharacterRepository (db.characters) & WorkflowRepository (db.workflows) handle data persistence.
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { CharacterMediaService } from "./CharacterMediaService.js";
import { CharacterGenerationService } from "./CharacterGenerationService.js";
import { assertOwns } from "../../platform/security/ownership.js";

export class CharacterService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                   - Repository map (db.characters, db.workflows, db.media, db.projects)
     * @param {Object} deps.storageService       - StorageService instance
     * @param {Object} deps.workflowService      - WorkflowLifecycleService instance
     * @param {Object} [deps.useCaseService]     - UseCaseService instance
     * @param {Object} [deps.mediaService]       - Optional pre-configured CharacterMediaService
     * @param {Object} [deps.generationService]  - Optional pre-configured CharacterGenerationService
     */
    constructor({ db, storageService, workflowService, useCaseService, mediaIngestionService, mediaService, generationService }) {
        this.db = db;
        this.storageService = storageService;
        this.workflowService = workflowService;
        this.mediaIngestionService = mediaIngestionService;

        this.mediaService = mediaService || new CharacterMediaService({ db, storageService, mediaIngestionService });
        this.generationService = generationService || new CharacterGenerationService({ db, useCaseService });
    }

    /**
     * Allows setting/updating useCaseService after container initialization
     */
    setUseCaseService(useCaseService) {
        this.generationService.useCaseService = useCaseService;
    }

    // ── createCharacter ──────────────────────────────────────────────────────

    /**
     * Creates a new Character workflow container and character DB row.
     * If an uploaded file or imageUrl is provided, stores the sheet media directly without AI generation.
     * Otherwise, enqueues the AI turnaround sheet generation job via Redis.
     */
    async createCharacter({
        projectId,
        userId,
        workflowId,
        name,
        prompt = "",
        description = "",
        file = null,
        imageUrl = null,
        references = [],
    }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "createCharacter", projectId });

        try {
            if (!projectId) {
                throw new CrudServiceError("project_id is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "createCharacter",
                });
            }

            if (userId) {
                await assertOwns("project", projectId, userId);
            }

            const characterId = workflowId || randomUUID();
            const charName = name?.trim() || prompt?.slice(0, 40) || "Untitled Character";
            const charPrompt = (prompt || description)?.trim() || charName;

            // Resolve userId — fallback to project owner if not provided or anonymous
            const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            let safeUserId = userId;
            if (!safeUserId || !UUID_REGEX.test(safeUserId)) {
                const proj = await this.db.projects.findById(projectId).catch(() => null);
                if (proj?.user_id) safeUserId = proj.user_id;
            }

            // 1. Create workflow container row FIRST to satisfy Foreign Key constraint
            await this.db.workflows.createWorkflow({
                id: characterId,
                project_id: projectId,
                user_id: safeUserId,
                workflow_type: "CHARACTER_SHEET",
                display_name: charName,
            }).catch(async (wfErr) => {
                console.warn(`⚠️ [CharacterService] createWorkflow container notice:`, wfErr.message);
                await this.db.workflows.updateFields(characterId, {
                    display_name: charName,
                    project_id: projectId,
                    workflow_type: "CHARACTER_SHEET",
                }).catch(() => null);
            });

            // 2. Upsert character row in characters table
            const upsertPayload = {
                id: characterId,
                workflow_id: characterId,
                project_id: projectId,
                user_id: safeUserId,
                name: charName,
                title: charName,
                description: charPrompt,
                character_info: charPrompt,
                updated_at: new Date().toISOString(),
            };

            const char = await this.db.characters.upsert(upsertPayload).catch(async (err) => {
                console.error(`❌ [CharacterService] createCharacter upsert error:`, err.message);
                const proj = await this.db.projects.findById(projectId).catch(() => null);
                if (proj?.user_id && proj.user_id !== safeUserId) {
                    upsertPayload.user_id = proj.user_id;
                    return this.db.characters.upsert(upsertPayload).catch(() => null);
                }
                return null;
            });

            // 3. Case A: User uploaded an image directly (file or imageUrl)
            if (file || imageUrl) {
                const sheetRes = await this.mediaService.uploadSheetMedia({
                    characterId,
                    file,
                    imageUrl,
                    projectId,
                    userId: safeUserId,
                });

                crudOperationLog({
                    traceId,
                    operation: "createCharacter",
                    status: "ok",
                    durationMs: Date.now() - start,
                    characterId,
                    mode: "upload",
                });

                return {
                    characterId,
                    workflowId: characterId,
                    status: "completed",
                    message: "Character created with uploaded image.",
                    project_id: projectId,
                    character: char || upsertPayload,
                    workflow: { id: characterId, workflow_type: "CHARACTER_SHEET", status: "completed" },
                    media: sheetRes.media,
                };
            }

            // 4. Case B: AI Visual Sheet Generation
            const genResult = await this.generationService.enqueueSheetGeneration({
                characterId,
                prompt: charPrompt,
                references,
                projectId,
                userId: safeUserId,
                name: charName,
            });

            crudOperationLog({
                traceId,
                operation: "createCharacter",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
                mode: "ai-generation",
            });

            return {
                characterId,
                workflowId: characterId,
                taskId: genResult.taskId,
                status: genResult.status,
                needsCredits: genResult.needsCredits,
                message: genResult.message,
                project_id: projectId,
                character: char || upsertPayload,
                workflow: { id: characterId, workflow_type: "CHARACTER_SHEET" },
                media: genResult.placeholderMedia,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "createCharacter",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    // ── updateCharacter ──────────────────────────────────────────────────────

    /**
     * Updates character attributes (name, title, description, character_info, traits, etc.)
     * and synchronizes workflow display_name.
     */
    async updateCharacter({ characterId, updates = {}, userId }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "updateCharacter", characterId });

        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "updateCharacter",
                });
            }

            if (userId) {
                await assertOwns("character", characterId, userId);
            }

            const charUpdates = { updated_at: new Date().toISOString() };
            const wfUpdates = {};

            const nameVal = updates.name || updates.title || updates.display_name;
            if (nameVal !== undefined) {
                const cleanName = String(nameVal || "").replace(/^@+/, "").trim();
                if (cleanName.length > 0) {
                    charUpdates.name = cleanName;
                    charUpdates.title = cleanName;
                    wfUpdates.display_name = cleanName;
                } else {
                    const existingChar = await this.db.characters.findByCharacterId(characterId).catch(() => null);
                    const fallbackName = existingChar?.name || existingChar?.title || "Untitled Character";
                    charUpdates.name = fallbackName;
                    charUpdates.title = fallbackName;
                    wfUpdates.display_name = fallbackName;
                }
            }

            const descVal = updates.description !== undefined ? updates.description : updates.character_info;
            if (descVal !== undefined) {
                const cleanDesc = String(descVal || "").trim();
                charUpdates.description = cleanDesc;
                charUpdates.character_info = cleanDesc;
            }

            if (updates.archetype !== undefined) charUpdates.archetype = updates.archetype;
            if (updates.gender !== undefined) charUpdates.gender = updates.gender;
            if (updates.style !== undefined) charUpdates.style = updates.style;
            if (updates.traits !== undefined) charUpdates.traits = updates.traits;
            if (updates.keywords !== undefined) charUpdates.keywords = updates.keywords;
            if (updates.guidelines !== undefined) charUpdates.guidelines = updates.guidelines;
            if (updates.more_details !== undefined) {
                charUpdates.traits = { ...(charUpdates.traits || {}), more_details: updates.more_details };
            }
            if (updates.status !== undefined) charUpdates.status = updates.status;
            if (updates.is_favorited !== undefined) charUpdates.is_favorited = Boolean(updates.is_favorited);
            if (updates.favorited !== undefined) charUpdates.is_favorited = Boolean(updates.favorited);

            let updatedChar = await this.db.characters.updateCharacterFields(characterId, charUpdates).catch((err) => {
                console.warn(`⚠️ [CharacterService] updateCharacter notice:`, err.message);
                return null;
            });

            if (!updatedChar) {
                const wfRow = await this.db.workflows.getWorkflow(characterId).catch(() => null);
                const insertPayload = {
                    id: characterId,
                    workflow_id: characterId,
                    project_id: wfRow?.project_id || null,
                    user_id: userId || wfRow?.user_id || null,
                    name: charUpdates.name || "Untitled Character",
                    title: charUpdates.title || "Untitled Character",
                    description: charUpdates.description || "",
                    character_info: charUpdates.character_info || "",
                    ...charUpdates,
                };
                updatedChar = await this.db.characters.upsert(insertPayload).catch(() => null);
            }

            let updatedWf = null;
            if (Object.keys(wfUpdates).length > 0) {
                updatedWf = await this.db.workflows.updateFields(characterId, wfUpdates).catch(() => null);
            }

            crudOperationLog({
                traceId,
                operation: "updateCharacter",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
            });

            return {
                character: updatedChar || { id: characterId, ...charUpdates },
                workflow: updatedWf,
            };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "updateCharacter",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    // ── deleteCharacter ──────────────────────────────────────────────────────

    /**
     * Deletes a character, including workflows, characters table entry, and associated media.
     */
    async deleteCharacter({ characterId, userId, req = null }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "deleteCharacter", characterId });

        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "deleteCharacter",
                });
            }

            if (userId) {
                await assertOwns("character", characterId, userId);
            }

            await this.db.characters.deleteById(characterId).catch((charDeleteErr) => {
                console.warn(`⚠️ [CharacterService] deleteCharacter row notice:`, charDeleteErr.message);
            });

            const result = await this.workflowService.deleteWorkflow({ workflowId: characterId, userId, req });

            crudOperationLog({
                traceId,
                operation: "deleteCharacter",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
            });

            return result;
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "deleteCharacter",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    // ── Media Delegations ────────────────────────────────────────────────────

    /**
     * Set or upload turnaround body sheet media
     */
    async setCharacterSheetMedia(params) {
        if (params?.userId && params?.characterId) {
            await assertOwns("character", params.characterId, params.userId);
        }
        return await this.mediaService.uploadSheetMedia(params);
    }

    /**
     * Add a detail reference image to character
     */
    async addMediaToCharacter(params) {
        if (params?.userId && params?.characterId) {
            await assertOwns("character", params.characterId, params.userId);
        }
        return await this.mediaService.uploadDetailMedia(params);
    }

    /**
     * Remove a detail reference image from character
     */
    async removeMediaFromCharacter(params) {
        if (params?.userId && params?.characterId) {
            await assertOwns("character", params.characterId, params.userId);
        }
        return await this.mediaService.removeDetailMedia(params);
    }

    // ── AI Generation Delegations ────────────────────────────────────────────

    /**
     * Generate or regenerate turnaround sheet
     */
    async generateCharacterSheet({ characterId, prompt, references, projectId, userId }) {
        if (userId) {
            await assertOwns("character", characterId, userId);
            if (projectId) {
                await assertOwns("project", projectId, userId);
            }
        }

        const wf = await this.db.workflows.getWorkflow(characterId).catch(() => null);
        const existingChar = await this.db.characters.findByCharacterId(characterId).catch(() => null);

        const targetProjectId = projectId || wf?.project_id || existingChar?.project_id;
        const charName = existingChar?.name || wf?.display_name || "Untitled Character";
        const effectivePrompt = (prompt && prompt.trim()) || existingChar?.description || existingChar?.character_info || charName;

        // If prompt was updated, synchronize character entity
        if (prompt && prompt.trim() && prompt.trim() !== existingChar?.description) {
            await this.updateCharacter({
                characterId,
                updates: { description: prompt.trim(), character_info: prompt.trim() },
                userId,
            }).catch(() => null);
        }

        return await this.generationService.enqueueSheetGeneration({
            characterId,
            prompt: effectivePrompt,
            references: Array.isArray(references) ? references : [],
            projectId: targetProjectId,
            userId,
            name: charName,
        });
    }

    /**
     * Generate an evocative character prompt using the AI Art Director
     */
    async generateDescription(params) {
        return await this.generationService.generateDescription(params);
    }
}

export default CharacterService;
