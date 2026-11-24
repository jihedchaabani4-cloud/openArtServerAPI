/**
 * GenerationRequestService
 * @owns System 1: Generation & Workflows — orchestrates the lifecycle of generation requests (image/video).
 *   1. Folder validation
 *   2. Workflow & single Media placeholder row persistence
 *   3. Relation linking via WorkflowMedia
 *   4. ExecutionEngine launch (ownership, cost, credit hold, Redis queue dispatch)
 *   5. Failure compensation (marking placeholder status on billing error or dispatch failure)
 */

import { randomUUID } from "node:crypto";
import { AppError, createLogger } from "#shared";
import {
    createGenerationPlaceholderAtomic,
    appendMediaToWorkflow,
    calculateAspectRatio,
} from "#media/tools";
import { toMediaIdList } from "#identity/tools";
import { validateModelInputs, getModelSchema } from "#models/tools";

const logger = createLogger("generation_request_service");
const ARRAY_MEDIA_PARAM_KEYS = ["images", "reference_images", "reference_videos"];

export class GenerationRequestService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db
     * @param {Object} [deps.executionEngine]
     * @param {Object} [deps.useCaseService]
     * @param {Object} deps.folderService
     * @param {Function} [deps.modelValidator]
     */
    constructor({ db, executionEngine, useCaseService, folderService, modelValidator = validateModelInputs }) {
        this.db = db;
        this.executionEngine = executionEngine || useCaseService;
        this.folderService = folderService;
        this.modelValidator = modelValidator;
    }

    /**
     * Executes the shared generation request lifecycle for single-output image and video workflows.
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
        defaultMessages = {},
    }) {
        let workflowId = null;
        let mediaId = null;
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

        // 2b. Strip secrets & client batch params BEFORE model validation
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
            const requestedWorkflowId = randomUUID();
            const requestedMediaId = randomUUID();

            // 5-6. Atomically create Workflow + single Media placeholder (with pre-persisted generation_config)
            //      + workflow_media primary link in 1 DB hop via create_generation_placeholder_atomic RPC
            //      (with safe multi-step fallback for mock db objects / pre-migration environments).
            const placeholder = await createGenerationPlaceholderAtomic(this.db, {
                workflowId: requestedWorkflowId,
                mediaId: requestedMediaId,
                projectId,
                userId,
                displayName: (prompt || "").slice(0, 60),
                workflowType: "GENERATION",
                folderId: validatedFolderId,
                stepId,
                width: mediaMeta.width,
                height: mediaMeta.height,
                generationConfig: initialGenerationConfig,
                operation: `${mediaType}Generation:linkWorkflowMedia`,
            });

            workflowId = placeholder.workflowId || requestedWorkflowId;
            mediaId = placeholder.mediaId || requestedMediaId;
            serverMediaIds = [mediaId];
            logger.info({ workflowId, mediaId, projectId, mediaType, atomic: placeholder.atomic }, `Workflow and media placeholder created`);

            // 7. Prepare ExecutionEngine runtime input
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

            // 8. Credit reservation & Redis job dispatch via ExecutionEngine
            let taskId = null;
            let hasSufficientCredits = true;
            let creditErrorMsg = null;
            let calculatedCost = null;

            try {
                logger.debug({ workflowId, useCase: useCaseId }, "Launching workflow via ExecutionEngine");
                const prepared = await this.executionEngine.launch({
                    useCaseId,
                    input: runtimeInput,
                    userId,
                    executionId: randomUUID(),
                    traceId: workflowId,
                    projectId,
                    serverContext: {
                        workflowId,
                        mediaIds: serverMediaIds,
                        projectId,
                    },
                });

                taskId = prepared.jobId || prepared.executionId || workflowId;
                calculatedCost = prepared.cost?.totalCredits ?? null;
                logger.info({ calculatedCost, taskId }, `Reserved ${calculatedCost} credits & enqueued job "${taskId}"`);
            } catch (serviceErr) {
                if (
                    serviceErr.code === "INSUFFICIENT_FUNDS" ||
                    serviceErr.code === "INSUFFICIENT_CREDITS" ||
                    serviceErr.code === "BILLING_HOLD_REQUIRED"
                ) {
                    hasSufficientCredits = false;
                    creditErrorMsg = serviceErr.message;
                    logger.warn({ workflowId, code: serviceErr.code }, `Billing error: ${serviceErr.message}`);
                } else if (serviceErr.code === "QUEUE_DISPATCH_FAILED") {
                    logger.error({ workflowId, code: serviceErr.code }, `Queue dispatch failed: ${serviceErr.message}`);
                    if (mediaId && this.db?.media?.updateMedia) {
                        await this.db.media.updateMedia(mediaId, {
                            status: "failed",
                            error_message: serviceErr.message,
                        }).catch(() => {});
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

            if (!hasSufficientCredits && mediaId && this.db?.media?.updateMedia) {
                await this.db.media.updateMedia(mediaId, {
                    status: "saved",
                    error_message: creditErrorMsg || "Insufficient credits",
                }).catch(() => {});
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
            if (err.code !== "QUEUE_DISPATCH_FAILED" && mediaId && this.db?.media?.updateMedia) {
                await this.db.media.updateMedia(mediaId, {
                    status: "failed",
                    error_message: err.message || `Failed to prepare ${mediaType} generation request`,
                }).catch(() => {});
            }
            throw err;
        }
    }

    /**
     * Checks whether a workflow is currently in the trash repository.
     * Supports canonical TrashRepository methods as well as test double shapes.
     */
    async _isWorkflowTrashed(workflowId, userId) {
        const trashRepo = this.db?.trash;
        if (!trashRepo) return false;

        if (typeof trashRepo.getTrashedWorkflowIdSet === "function") {
            const trashedSet = await trashRepo.getTrashedWorkflowIdSet({ workflowIds: [workflowId] });
            return trashedSet instanceof Set ? trashedSet.has(workflowId) : false;
        }
        if (typeof trashRepo.listWorkflowIds === "function") {
            const trashedIds = await trashRepo.listWorkflowIds({ workflowIds: [workflowId] });
            return Array.isArray(trashedIds) && trashedIds.includes(workflowId);
        }
        if (typeof trashRepo.getTrashedDetailsMap === "function") {
            const trashedMap = await trashRepo.getTrashedDetailsMap({ workflowIds: [workflowId] });
            return trashedMap instanceof Map ? trashedMap.has(workflowId) : false;
        }
        if (typeof trashRepo.findTrashedWorkflowIds === "function") {
            const trashedIds = await trashRepo.findTrashedWorkflowIds({ userId, workflowIds: [workflowId] });
            return Array.isArray(trashedIds) && trashedIds.includes(workflowId);
        }
        if (typeof trashRepo.findByWorkflowId === "function") {
            const row = await trashRepo.findByWorkflowId(workflowId);
            return Boolean(row);
        }
        if (typeof trashRepo.isTrashed === "function") {
            return Boolean(await trashRepo.isTrashed(workflowId));
        }

        return false;
    }

    /**
     * Executes an in-place image edit request (e.g. relight, angles) on an existing workflow.
     *
     * Appends a new placeholder media row into the same parent workflow, flips `is_primary = true`
     * immediately on creation, reserves credits, and launches the corresponding V3 use case.
     */
    async requestImageEdit({
        userId,
        workflowId,
        editType,
        stepId,
        useCaseId,
        model,
        prompt,
        userPrompt = "",
        references = [],
        editSettings = {},
        templateVars = null,
        parameters = {},
        defaultMessages = {},
    }) {
        // 1. Workflow lookup & Trash check
        const workflow = typeof this.db?.workflows?.findById === "function"
            ? await this.db.workflows.findById(workflowId)
            : (typeof this.db?.workflows?.getWorkflow === "function"
                ? await this.db.workflows.getWorkflow(workflowId)
                : null);

        if (!workflow) {
            throw new AppError("Workflow not found", 404, { code: "WORKFLOW_NOT_FOUND" });
        }

        if (await this._isWorkflowTrashed(workflowId, userId)) {
            throw new AppError("Cannot edit media inside a trashed workflow", 409, {
                code: "WORKFLOW_TRASHED",
            });
        }

        // 2. Server-Resolved Primary Media Lookup
        const primaryMedia = typeof this.db?.workflowMedia?.getPrimaryMedia === "function"
            ? await this.db.workflowMedia.getPrimaryMedia(workflowId)
            : null;

        if (!primaryMedia) {
            throw new AppError("Workflow has no primary image to edit", 400, {
                code: "PRIMARY_MEDIA_NOT_FOUND",
            });
        }

        if (primaryMedia.status === "processing" || primaryMedia.status === "pending") {
            throw new AppError("Primary media is still processing and cannot be edited yet", 409, {
                code: "PRIMARY_MEDIA_NOT_READY",
            });
        }

        const hasValidUrl =
            typeof primaryMedia.url === "string" &&
            (primaryMedia.url.startsWith("http://") || primaryMedia.url.startsWith("https://"));

        if (primaryMedia.status !== "success" || !hasValidUrl) {
            throw new AppError("Primary media is not in a valid completed state for editing", 400, {
                code: "PRIMARY_MEDIA_INVALID",
            });
        }

        const sourceMediaId = primaryMedia.id || primaryMedia.media_id;

        // 3. Dimension & Aspect Ratio Inheritance + Model Validation
        const width = Number(primaryMedia.width) > 0 ? Number(primaryMedia.width) : 1024;
        const height = Number(primaryMedia.height) > 0 ? Number(primaryMedia.height) : 1024;

        const rawDerivedAspectRatio =
            (typeof primaryMedia.generation_config?.aspect_ratio === "string" &&
                primaryMedia.generation_config.aspect_ratio.trim()) ||
            calculateAspectRatio(width, height) ||
            "1:1";

        const resolvedParams = parameters && typeof parameters === "object" ? { ...parameters } : {};
        let inheritedAspectRatio = rawDerivedAspectRatio;

        if (!resolvedParams.aspect_ratio) {
            try {
                const schema = getModelSchema(model);
                const arDef = schema?.parameters?.aspect_ratio;
                if (arDef) {
                    const allowedValues = Array.isArray(arDef.values) ? arDef.values.map(String) : null;
                    if (!allowedValues || allowedValues.length === 0 || allowedValues.includes(String(rawDerivedAspectRatio))) {
                        resolvedParams.aspect_ratio = rawDerivedAspectRatio;
                        inheritedAspectRatio = rawDerivedAspectRatio;
                    } else {
                        const fallbackRatio = arDef.default || "1:1";
                        resolvedParams.aspect_ratio = fallbackRatio;
                        inheritedAspectRatio = fallbackRatio;
                    }
                }
            } catch {
                // Unknown model will be handled by this.modelValidator below
            }
        } else {
            inheritedAspectRatio = resolvedParams.aspect_ratio;
        }

        const SECRET_PATTERN = /secret|token|password|auth|bearer|api[_-]?key/i;
        const STRIPPED_EDIT_KEYS = new Set(["count", "outputCount", "output_count", "images", "input_image", "prompt"]);
        const preValidationParams = {};
        for (const [k, v] of Object.entries(resolvedParams)) {
            if (!SECRET_PATTERN.test(k) && !STRIPPED_EDIT_KEYS.has(k)) {
                preValidationParams[k] = v;
            }
        }

        let cleanInput;
        const trimmedEditPrompt = (prompt || "").trim();
        const isRemoveBackground = editType === "remove_background";
        try {
            const validationPayload = isRemoveBackground
                ? {
                    ...preValidationParams,
                    input_image: primaryMedia.url,
                    ...(trimmedEditPrompt ? { prompt: trimmedEditPrompt } : {}),
                }
                : {
                    ...preValidationParams,
                    prompt: trimmedEditPrompt,
                };
            cleanInput = this.modelValidator(model, validationPayload);
        } catch (valErr) {
            const statusCode = valErr.statusCode || 400;
            const appErr = new AppError(valErr.message, statusCode);
            appErr.code = valErr.code || "VALIDATION_ERROR";
            appErr.field = valErr.field;
            throw appErr;
        }

        const sanitizedParams = {};
        for (const [k, v] of Object.entries(cleanInput)) {
            if (k !== "prompt" && (!isRemoveBackground || k !== "input_image")) {
                sanitizedParams[k] = v;
            }
        }

        const finalPrompt = cleanInput.prompt || trimmedEditPrompt;
        const trimmedUserPrompt = typeof userPrompt === "string" ? userPrompt.trim() : "";

        const initialGenerationConfig = {
            prompt: finalPrompt,
            ...(trimmedUserPrompt ? { user_prompt: trimmedUserPrompt } : {}),
            model,
            edit_type: editType,
            source_media_id: sourceMediaId,
            edit_settings: editSettings,
            aspect_ratio: cleanInput.aspect_ratio || inheritedAspectRatio || "1:1",
            parameters: sanitizedParams,
            created_at: new Date().toISOString(),
        };

        let newMediaId = null;

        try {
            // 4. In-Place Placeholder Append + Immediate `is_primary = true` Swap
            const requestedMediaId = randomUUID();
            const createdMedia = await appendMediaToWorkflow(this.db, {
                workflow_id: workflowId,
                mediaData: {
                    id: requestedMediaId,
                    project_id: workflow.project_id,
                    step_id: stepId,
                    url: null,
                    width,
                    height,
                    generation_config: initialGenerationConfig,
                },
                setAsPrimary: true,
                initialStatus: "processing",
            });

            newMediaId = createdMedia?.id || requestedMediaId;
            const serverMediaIds = [newMediaId];
            logger.info(
                { workflowId, mediaId: newMediaId, sourceMediaId, projectId: workflow.project_id, editType },
                "In-place image edit placeholder appended and promoted to primary"
            );

            // 5. Launch V3 Workflow via ExecutionEngine
            const runtimeInput = {
                prompt: finalPrompt,
                model,
                source_image_url: primaryMedia.url,
                source_media_id: sourceMediaId,
                aspect_ratio: cleanInput.aspect_ratio || inheritedAspectRatio,
                width,
                height,
                references: Array.isArray(references) ? references : [],
                parameters: sanitizedParams,
                edit_settings: editSettings,
                ...(templateVars && typeof templateVars === "object"
                    ? { template_vars: templateVars }
                    : {}),
                project_id: workflow.project_id,
                workflow_id: workflowId,
                media_id: newMediaId,
                serverWorkflowId: workflowId,
                serverMediaIds,
                serverProjectId: workflow.project_id,
            };

            let taskId = null;
            let hasSufficientCredits = true;
            let creditErrorMsg = null;
            let calculatedCost = null;

            try {
                logger.debug({ workflowId, mediaId: newMediaId, useCase: useCaseId }, "Launching image edit workflow via ExecutionEngine");
                const prepared = await this.executionEngine.launch({
                    useCaseId,
                    input: runtimeInput,
                    userId,
                    executionId: randomUUID(),
                    traceId: workflowId,
                    projectId: workflow.project_id,
                    serverContext: {
                        workflowId,
                        mediaIds: serverMediaIds,
                        projectId: workflow.project_id,
                    },
                });

                taskId = prepared.jobId || prepared.executionId || workflowId;
                calculatedCost = prepared.cost?.totalCredits ?? null;
                logger.info(
                    { calculatedCost, taskId, workflowId, mediaId: newMediaId, editType },
                    `Reserved ${calculatedCost} credits & enqueued image edit job "${taskId}"`
                );
            } catch (serviceErr) {
                if (
                    serviceErr.code === "INSUFFICIENT_FUNDS" ||
                    serviceErr.code === "INSUFFICIENT_CREDITS" ||
                    serviceErr.code === "BILLING_HOLD_REQUIRED"
                ) {
                    hasSufficientCredits = false;
                    creditErrorMsg = serviceErr.message;
                    logger.warn({ workflowId, mediaId: newMediaId, code: serviceErr.code }, `Billing error: ${serviceErr.message}`);
                } else if (serviceErr.code === "QUEUE_DISPATCH_FAILED") {
                    logger.error({ workflowId, mediaId: newMediaId, code: serviceErr.code }, `Queue dispatch failed: ${serviceErr.message}`);
                    if (newMediaId && this.db?.media?.updateMedia) {
                        await this.db.media.updateMedia(newMediaId, {
                            status: "failed",
                            error_message: serviceErr.message,
                        }).catch(() => {});
                    }
                    const dispatchError = new AppError(serviceErr.message, 503);
                    dispatchError.code = "QUEUE_DISPATCH_FAILED";
                    dispatchError.workflowId = workflowId;
                    dispatchError.mediaId = newMediaId;
                    dispatchError.mediaIds = serverMediaIds;
                    throw dispatchError;
                } else {
                    throw serviceErr;
                }
            }

            // 6. Compensation & Return DTO
            if (!hasSufficientCredits && newMediaId && this.db?.media?.updateMedia) {
                await this.db.media.updateMedia(newMediaId, {
                    status: "saved",
                    error_message: creditErrorMsg || "Insufficient credits",
                }).catch(() => {});
            }

            return {
                ok: true,
                status: hasSufficientCredits ? "processing" : "saved",
                needsCredits: !hasSufficientCredits,
                message: hasSufficientCredits
                    ? (defaultMessages.started || `Image ${editType} started.`)
                    : (creditErrorMsg || defaultMessages.addCredits || `Add credits to ${editType} your image.`),
                cost: calculatedCost,
                workflowId,
                mediaId: newMediaId,
                sourceMediaId,
                mediaIds: serverMediaIds,
                taskId,
                project_id: workflow.project_id,
                session_id: null,
                workflow: {
                    id: workflowId,
                    primary_media_id: newMediaId,
                    media_ids: serverMediaIds,
                    workflow_type: workflow.workflow_type || "GENERATION",
                },
            };
        } catch (err) {
            if (err.code !== "QUEUE_DISPATCH_FAILED" && newMediaId && this.db?.media?.updateMedia) {
                await this.db.media.updateMedia(newMediaId, {
                    status: "failed",
                    error_message: err.message || `Failed to prepare image ${editType} request`,
                }).catch(() => {});
            }
            throw err;
        }
    }
}
