/**
 * GenerationRequestService
 * @owns System 1: Generation & Workflows — orchestrates the lifecycle of generation requests (image/video).
 *   1. Folder validation
 *   2. Workflow & Media placeholder row persistence
 *   3. Relation linking via WorkflowMedia
 *   4. UseCase runtime input formulation & credit reservation / Redis queue dispatch
 *   5. Failure compensation (marking placeholder status on billing error or dispatch failure)
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../../utils/AppError.js";
import { createLogger } from "../../infrastructure/logging/index.js";
import { createMediaInWorkflow } from "../../db/workflowMediaLinker.js";
import { toMediaIdList } from "#platform/identity";
import { validateInput, getModelSchema } from "../../models/index.js";

const logger = createLogger("generation_request_service");
const ARRAY_MEDIA_PARAM_KEYS = ["images", "reference_images", "reference_videos"];

export class GenerationRequestService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db
     * @param {Object} deps.useCaseService
     * @param {Object} deps.folderService
     * @param {Function} [deps.modelValidator]
     */
    constructor({ db, useCaseService, folderService, modelValidator = validateInput }) {
        this.db = db;
        this.useCaseService = useCaseService;
        this.folderService = folderService;
        this.modelValidator = modelValidator;
    }

    /**
     * Executes the shared generation request lifecycle for image and video workflows.
     */
    async requestGeneration({
        userId,
        mediaType,
        stepId,
        useCaseId,
        prompt,
        model,
        projectId,
        folderId,
        references = [],
        parameters = {},
        mediaMeta = {},
        outputCount = 1,
        defaultMessages = {},
    }) {
        let workflowId = null;
        let serverMediaIds = [];

        // 1. Enforce folder usability if folderId is provided (security & tenancy check first)
        const validatedFolderId = this.folderService?.validateAndAssertUsable
            ? await this.folderService.validateAndAssertUsable(folderId, userId, projectId)
            : folderId;

        // 2. Prepare and resolve model parameters & media keys
        const resolvedParams = parameters && typeof parameters === "object" ? { ...parameters } : {};
        for (const arrayKey of ARRAY_MEDIA_PARAM_KEYS) {
            if (resolvedParams[arrayKey] !== undefined && resolvedParams[arrayKey] !== null) {
                resolvedParams[arrayKey] = toMediaIdList(resolvedParams[arrayKey]);
            }
        }
        if (mediaMeta?.aspect_ratio && !resolvedParams.aspect_ratio) {
            try {
                const schema = getModelSchema(model);
                if (schema?.parameters?.aspect_ratio) {
                    resolvedParams.aspect_ratio = mediaMeta.aspect_ratio;
                }
            } catch {
                // Unknown model will be handled by this.modelValidator below
            }
        }

        // 2b. Strip secrets & framework batch params (count) BEFORE model validation
        const SECRET_PATTERN = /secret|token|password|auth|bearer|api[_-]?key/i;
        const CLIENT_BATCH_KEYS = new Set(["count", "outputCount", "output_count"]);
        const preValidationParams = {};
        for (const [k, v] of Object.entries(resolvedParams)) {
            if (!SECRET_PATTERN.test(k) && !CLIENT_BATCH_KEYS.has(k)) {
                preValidationParams[k] = v;
            }
        }

        // 3. Validate and normalize input against the selected model's actual canonical schema BEFORE execution or DB mutations
        let cleanInput;
        try {
            cleanInput = this.modelValidator(model, {
                prompt: (prompt || "").trim(),
                ...preValidationParams,
            });
        } catch (valErr) {
            const statusCode = valErr.statusCode || 400;
            const appErr = new AppError(valErr.message, statusCode);
            appErr.code = valErr.code || "VALIDATION_ERROR";
            appErr.field = valErr.field;
            throw appErr;
        }

        // 4. Build sanitized initial generation configuration — cleanInput already excludes secrets & client batch keys
        const sanitizedParams = {};
        for (const [k, v] of Object.entries(cleanInput)) {
            if (k !== "prompt") {
                sanitizedParams[k] = v;
            }
        }

        const initialGenerationConfig = {
            prompt: cleanInput.prompt || (prompt || "").trim(),
            model,
            aspect_ratio: cleanInput.aspect_ratio || mediaMeta?.aspect_ratio || "1:1",
            parameters: sanitizedParams,
            created_at: new Date().toISOString(),
        };

        try {
            workflowId = randomUUID();

            // 5. Create Workflow container
            await this.db.workflows.createWorkflow({
                id: workflowId,
                project_id: projectId,
                session_id: null,
                display_name: (prompt || "").slice(0, 60),
                workflow_type: "GENERATION",
                folder_id: validatedFolderId,
                user_id: userId,
            });

            logger.info({ workflowId, projectId, outputCount, mediaType }, `Workflow created: ${workflowId}`);

            // 6. Create Media placeholder(s) with pre-persisted generation_config
            for (let i = 0; i < outputCount; i++) {
                const id = randomUUID();
                await this.db.media.createMedia({
                    id,
                    project_id: projectId,
                    step_id: stepId,
                    url: null,
                    width: mediaMeta.width,
                    height: mediaMeta.height,
                    status: "processing",
                    generation_config: initialGenerationConfig,
                });

                await createMediaInWorkflow(this.db, {
                    workflowId,
                    mediaId: id,
                    stepId,
                    workflowType: "GENERATION",
                    operation: `${mediaType}Generation:linkWorkflowMedia`,
                });

                serverMediaIds.push(id);
            }

            const mediaId = serverMediaIds[0];
            logger.info({ mediaId, serverMediaIds, workflowId }, `Media placeholder(s) created`);

            // 7. Prepare UseCase runtime input
            const runtimeInput = {
                prompt: cleanInput.prompt || (prompt || "").trim(),
                model,
                aspect_ratio: cleanInput.aspect_ratio || mediaMeta.aspect_ratio,
                width: mediaMeta.width,
                height: mediaMeta.height,
                references,
                parameters: sanitizedParams,
                project_id: projectId,
                workflow_id: workflowId,
                media_id: mediaId,
                serverWorkflowId: workflowId,
                serverMediaIds,
                serverProjectId: projectId,
            };

            // 8. Credit reservation & Redis job dispatch
            let taskId = null;
            let hasSufficientCredits = true;
            let creditErrorMsg = null;
            let calculatedCost = null;

            try {
                logger.debug({ workflowId, useCase: useCaseId }, "Preparing & reserving credits");
                const prepared = await this.useCaseService.prepareAndEnqueue({
                    useCaseId,
                    input: runtimeInput,
                    userId,
                    executionId: workflowId,
                    traceId: workflowId,
                    serverContext: {
                        workflowId,
                        v1_workflow_id: workflowId,
                        mediaIds: serverMediaIds,
                        projectId,
                    },
                });

                taskId = prepared.jobId || prepared.executionId || workflowId;
                calculatedCost = prepared.cost?.totalCredits ?? null;
                logger.info({ calculatedCost, taskId }, `Reserved ${calculatedCost} credits & enqueued job "${taskId}"`);
            } catch (serviceErr) {
                if (serviceErr.code === "INSUFFICIENT_CREDITS" || serviceErr.code === "BILLING_HOLD_REQUIRED") {
                    hasSufficientCredits = false;
                    creditErrorMsg = serviceErr.message;
                    logger.warn({ workflowId, code: serviceErr.code }, `Billing error: ${serviceErr.message}`);
                } else if (serviceErr.code === "QUEUE_DISPATCH_FAILED") {
                    logger.error({ workflowId, code: serviceErr.code }, `Queue dispatch failed: ${serviceErr.message}`);
                    if (serverMediaIds.length > 0 && this.db?.media?.updateMedia) {
                        for (const mId of serverMediaIds) {
                            await this.db.media.updateMedia(mId, {
                                status: "failed",
                                error_message: serviceErr.message,
                            }).catch(() => {});
                        }
                    }
                    const dispatchError = new AppError(serviceErr.message, 503);
                    dispatchError.code = "QUEUE_DISPATCH_FAILED";
                    dispatchError.workflowId = workflowId;
                    dispatchError.mediaId = mediaId;
                    dispatchError.mediaIds = serverMediaIds;
                    throw dispatchError;
                } else {
                    throw serviceErr;
                }
            }

            if (!hasSufficientCredits && serverMediaIds.length > 0 && this.db?.media?.updateMedia) {
                for (const mId of serverMediaIds) {
                    await this.db.media.updateMedia(mId, {
                        status: "saved",
                        error_message: creditErrorMsg || "Insufficient credits",
                    }).catch(() => {});
                }
            }

            return {
                ok: true,
                status: hasSufficientCredits ? "processing" : "saved",
                needsCredits: !hasSufficientCredits,
                message: hasSufficientCredits
                    ? (defaultMessages.started || `${mediaType} generation started.`)
                    : (creditErrorMsg || defaultMessages.addCredits || `Add credits to generate your ${mediaType}.`),
                cost: calculatedCost,
                workflowId,
                mediaId,
                mediaIds: serverMediaIds,
                taskId,
                project_id: projectId,
                session_id: null,
                workflow: {
                    id: workflowId,
                    primary_media_id: mediaId,
                    media_ids: serverMediaIds,
                    workflow_type: "GENERATION",
                },
            };
        } catch (err) {
            if (err.code !== "QUEUE_DISPATCH_FAILED" && serverMediaIds.length > 0 && this.db?.media?.updateMedia) {
                for (const mId of serverMediaIds) {
                    await this.db.media.updateMedia(mId, {
                        status: "failed",
                        error_message: err.message || `Failed to prepare ${mediaType} generation request`,
                    }).catch(() => {});
                }
            }
            throw err;
        }
    }
}
