/**
 * @owns System 6: Characters
 * CharacterGenerationService
 * Dedicated Domain Service owning character AI generation orchestration:
 * - ExecutionEngine job dispatching for character 3-view turnaround sheet ("character-sheet-v3")
 * - LLM prompt generation for Haute-Couture character concepts
 */

import { randomUUID } from "node:crypto";
import { executeLLM } from "#models/tools";
import { crudOperationLog, CrudServiceError } from "#shared";
import { createMediaInWorkflow } from "#media/tools";
import { toMediaIdList } from "#identity/tools";

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

export class CharacterGenerationService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                - Repository map (db.workflows, db.characters, db.media)
     * @param {Object} [deps.executionEngine] - ExecutionEngine instance for credit check & job queuing
     */
    constructor({ db, executionEngine, useCaseService } = {}) {
        this.db = db;
        this.executionEngine = executionEngine || useCaseService || null;
    }

    /**
     * Allows setting/updating executionEngine after initialization
     */
    setExecutionEngine(executionEngine) {
        this.executionEngine = executionEngine;
    }

    /**
     * Prepare input, reserve credits, and dispatch background UseCase job
     * for generating the 3-view turnaround sheet.
     */
    async enqueueSheetGeneration({ characterId, workflowId, prompt, references = [], projectId, userId, name }) {
        const traceId = randomUUID();
        const start = Date.now();
        const resolvedWorkflowId = workflowId || characterId;

        crudOperationLog({ traceId, operation: "enqueueSheetGeneration", characterId, workflowId: resolvedWorkflowId });

        let placeholderMedia = null;
        try {
            if (!characterId && !workflowId) {
                throw new CrudServiceError("characterId or workflowId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "enqueueSheetGeneration",
                });
            }

            const charName = name?.trim() || prompt?.slice(0, 40) || "Untitled Character";
            const charPrompt = prompt?.trim() || charName;

            // 1. Create placeholder media record and link to character/workflow upfront so when base.save_media completes the media row, the character sheet is ready automatically
            try {
                placeholderMedia = await this.db.media.createMedia({
                    project_id: projectId,
                    step_id: "image_generation",
                    status: "processing",
                    url: null,
                    width: 1344,
                    height: 768,
                });
                const linkResult = await createMediaInWorkflow(this.db, {
                    workflowId: resolvedWorkflowId,
                    mediaId: placeholderMedia?.id,
                    role: "sheet",
                    stepId: "image_generation",
                    workflowType: "CHARACTER",
                    is_primary: true,
                    operation: "enqueueSheetGeneration:linkWorkflowMedia",
                });
                if (!linkResult) {
                    throw new Error(`Failed to link placeholder media ${placeholderMedia?.id} to workflow ${resolvedWorkflowId}`);
                }
                const targetCharId = characterId || resolvedWorkflowId;
                if (placeholderMedia?.id && targetCharId && this.db?.characters) {
                    const charPatch = {
                        primary_media_id: placeholderMedia.id,
                        updated_at: new Date().toISOString(),
                    };
                    if (typeof this.db.characters.updateCharacterFields === "function") {
                        await this.db.characters.updateCharacterFields(targetCharId, charPatch).catch(() => null);
                    } else if (typeof this.db.characters.updateCharacter === "function") {
                        await this.db.characters.updateCharacter(targetCharId, charPatch).catch(() => null);
                    }
                }
                if (placeholderMedia?.id && resolvedWorkflowId && this.db?.workflows) {
                    if (typeof this.db.workflows.updatePrimaryMedia === "function") {
                        await this.db.workflows.updatePrimaryMedia(resolvedWorkflowId, placeholderMedia.id).catch(() => null);
                    }
                }
            } catch (mediaErr) {
                if (placeholderMedia?.id && this.db?.media) {
                    await this.db.media.updateMedia(placeholderMedia.id, {
                        status: "failed",
                        error_message: mediaErr.message || "Failed to link workflow media",
                    }).catch(() => {});
                }
                crudOperationLog({
                    traceId,
                    operation: "enqueueSheetGeneration:placeholderMedia",
                    status: "error",
                    characterId,
                    workflowId: resolvedWorkflowId,
                    message: mediaErr.message,
                });
                throw mediaErr;
            }

            const mediaId = placeholderMedia?.id || null;
            const serverMediaIds = mediaId ? [mediaId] : [];

            // 2. Prepare Direct UseCase Runtime Input with verified server-side targets
            const runtimeInput = {
                project_id: projectId,
                workflow_id: resolvedWorkflowId,
                media_id: mediaId,
                serverWorkflowId: resolvedWorkflowId,
                serverMediaIds,
                serverProjectId: projectId,
                prompt: charPrompt,
                references: toMediaIdList(references),
                characters: [{ name: charName, description: charPrompt }],
                verify_ownership: false,
            };

            // 3. Dispatch ExecutionEngine job with credit reservation
            let taskId = null;
            let hasSufficientCredits = true;
            let creditErrorMsg = null;

            if (this.executionEngine) {
                const executionId = randomUUID();
                try {
                    const prepared = await this.executionEngine.launch({
                        useCaseId: "character-sheet-v3",
                        input: runtimeInput,
                        userId,
                        executionId,
                        traceId,
                        projectId,
                        serverContext: {
                            workflowId: resolvedWorkflowId,
                            characterId,
                            mediaIds: serverMediaIds,
                            projectId,
                        },
                    });
                    taskId = prepared?.executionId || prepared?.runId || prepared?.workflowRunId || executionId;
                } catch (serviceErr) {
                    const isInsufficientCredits =
                        serviceErr?.code === "INSUFFICIENT_FUNDS" ||
                        serviceErr?.code === "INSUFFICIENT_CREDITS" ||
                        serviceErr?.code === "BILLING_HOLD_REQUIRED";

                    if (isInsufficientCredits) {
                        crudOperationLog({
                            traceId,
                            operation: "enqueueSheetGeneration:credit",
                            status: "warning",
                            characterId,
                            message: serviceErr.message,
                        });
                        hasSufficientCredits = false;
                        creditErrorMsg = serviceErr.message;
                        if (placeholderMedia?.id && this.db?.media) {
                            await this.db.media.updateMedia(placeholderMedia.id, {
                                status: "saved",
                                error_message: creditErrorMsg,
                            }).catch(() => {});
                        }
                    } else {
                        // Queue dispatch failure or unexpected launch error: fail closed
                        if (placeholderMedia?.id && this.db?.media) {
                            await this.db.media.updateMedia(placeholderMedia.id, {
                                status: "failed",
                                error_message: serviceErr.message,
                            }).catch(() => {});
                        }
                        throw serviceErr;
                    }
                }
            }

            crudOperationLog({
                traceId,
                operation: "enqueueSheetGeneration",
                status: "ok",
                durationMs: Date.now() - start,
                characterId,
                taskId,
            });

            return {
                ok: true,
                taskId,
                executionId: taskId,
                status: hasSufficientCredits ? "processing" : "saved",
                needsCredits: !hasSufficientCredits,
                message: hasSufficientCredits
                    ? "Character sheet generation initiated."
                    : (creditErrorMsg || "Character saved! Add credits to generate the visual sheet."),
                placeholderMedia,
            };
        } catch (err) {
            if (placeholderMedia?.id && this.db?.media) {
                await this.db.media.updateMedia(placeholderMedia.id, {
                    status: "failed",
                    error_message: err.message || "Failed to prepare character sheet generation",
                }).catch(() => {});
            }
            crudOperationLog({
                traceId,
                operation: "enqueueSheetGeneration",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.errorCode || err.statusCode || 500,
                message: err.message,
            });
            throw err;
        }
    }

    /**
     * Generate an evocative character prompt using the AI Art Director
     */
    async generateDescription({ concept, archetype, style, userId = null } = {}) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "generateDescription" });

        try {
            const inputConcept = concept || archetype || "The Eccentric";
            const promptText = `Generate a masterwork character description for the concept: "${inputConcept}". ${
                style ? `Incorporate style influences: ${style}.` : ""
            }`;

            const result = await executeLLM({
                prompt: promptText,
                systemInstruction: CHARACTER_GENERATOR_SYSTEM_PROMPT,
                jsonMode: true,
                userId,
            });

            const parsed = result.json || {};
            const description =
                parsed.description ||
                result.raw ||
                "A visionary character with striking anatomical features and high-fashion editorial presence.";
            const title = parsed.title || inputConcept;
            const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];

            crudOperationLog({
                traceId,
                operation: "generateDescription",
                status: "ok",
                durationMs: Date.now() - start,
            });

            return { title, description, keywords, model: result.model };
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "generateDescription",
                status: "error",
                durationMs: Date.now() - start,
                message: err.message,
            });
            throw err;
        }
    }
}

export default CharacterGenerationService;
