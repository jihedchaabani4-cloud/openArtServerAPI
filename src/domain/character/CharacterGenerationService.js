/**
 * CharacterGenerationService
 * Dedicated Domain Service owning character AI generation orchestration:
 * - UseCase job dispatching for character 3-view turnaround sheet ("character-sheet-v1")
 * - LLM prompt generation for Haute-Couture character concepts
 */

import { randomUUID } from "node:crypto";
import { llmService } from "#platform/ai/LLMService.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { createMediaInWorkflow } from "../../db/workflowMediaLinker.js";
import { toMediaIdList } from "../../platform/security/ownership.js";

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
     * @param {Object} deps.db              - Repository map (db.workflows, db.characters, db.media)
     * @param {Object} deps.useCaseService  - UseCaseService instance for credit check & job queuing
     */
    constructor({ db, useCaseService }) {
        this.db = db;
        this.useCaseService = useCaseService;
    }

    /**
     * Prepare input, reserve credits, and dispatch background UseCase job
     * for generating the 3-view turnaround sheet.
     */
    async enqueueSheetGeneration({ characterId, prompt, references = [], projectId, userId, name }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "enqueueSheetGeneration", characterId });

        let placeholderMedia = null;
        try {
            if (!characterId) {
                throw new CrudServiceError("characterId is required", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "enqueueSheetGeneration",
                });
            }

            const charName = name?.trim() || prompt?.slice(0, 40) || "Untitled Character";
            const charPrompt = prompt?.trim() || charName;

            // 1. Create placeholder media record so UI shows loading state immediately
            try {
                placeholderMedia = await this.db.media.createMedia({
                    project_id: projectId,
                    step_id: "character_sheet",
                    status: "processing",
                    url: null,
                    width: 1344,
                    height: 768,
                });
                const linkResult = await createMediaInWorkflow(this.db, {
                    workflowId: characterId,
                    mediaId: placeholderMedia?.id,
                    stepId: "character_sheet",
                    workflowType: "CHARACTER",
                    operation: "enqueueSheetGeneration:linkWorkflowMedia",
                });
                if (!linkResult) {
                    throw new Error(`Failed to link placeholder media ${placeholderMedia?.id} to workflow ${characterId}`);
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
                    message: mediaErr.message,
                });
                throw mediaErr;
            }

            const mediaId = placeholderMedia?.id || null;
            const serverMediaIds = mediaId ? [mediaId] : [];

            // 2. Prepare Direct UseCase Runtime Input with verified server-side targets
            const runtimeInput = {
                project_id: projectId,
                workflow_id: characterId,
                media_id: mediaId,
                serverWorkflowId: characterId,
                serverMediaIds,
                serverProjectId: projectId,
                prompt: charPrompt,
                references: toMediaIdList(references),
                characters: [{ name: charName, description: charPrompt }],
            };

            // 3. Dispatch UseCase job with credit reservation
            let taskId = null;
            let hasSufficientCredits = true;
            let creditErrorMsg = null;

            if (this.useCaseService) {
                try {
                    const prepared = await this.useCaseService.prepareAndEnqueue({
                        useCaseId: "character-sheet-v1",
                        input: runtimeInput,
                        userId,
                        executionId: characterId,
                        traceId: characterId,
                        serverContext: {
                            workflowId: characterId,
                            v1_workflow_id: characterId,
                            mediaIds: serverMediaIds,
                            projectId,
                        },
                    });
                    taskId = prepared.executionId || prepared.workflowRunId || characterId;
                } catch (serviceErr) {
                    if (serviceErr.code === "INSUFFICIENT_CREDITS" || serviceErr.code === "BILLING_HOLD_REQUIRED") {
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
                        // Queue dispatch failure or unexpected prepare error: fail closed
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
                taskId,
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

            const result = await llmService.generate({
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
