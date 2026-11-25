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
import { AppError, createLogger, envConfig, redisConnection } from "#shared";
import {
    createGenerationPlaceholderAtomic,
    appendMediaToWorkflow,
    calculateAspectRatio,
} from "#media/tools";
import { toMediaIdList } from "#identity/tools";
import { validateModelInputs, getModelSchema } from "#models/tools";
import { assertAllowedMediaType } from "../v3/nodes/base/resolveRefsNode.js";

const logger = createLogger("generation_request_service");
const ARRAY_MEDIA_PARAM_KEYS = ["images", "reference_images", "reference_videos"];
const SECRET_PARAM_PATTERN = /secret|token|password|auth|bearer|api[_-]?key/i;
const CLIENT_BATCH_KEYS = new Set(["count", "outputCount", "output_count"]);
const BILLING_ERROR_CODES = new Set(["INSUFFICIENT_FUNDS", "INSUFFICIENT_CREDITS", "BILLING_HOLD_REQUIRED"]);
const EDIT_LOCK_TTL_MS = 15_000;
const RELEASE_LOCK_LUA = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;
const UNEDITABLE_SHEET_WORKFLOW_TYPES = new Set([
    "CHARACTER",
    "CHARACTER_SHEET",
    "ELEMENT",
    "ELEMENT_SHEET",
]);

export class GenerationRequestService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db
     * @param {Object} [deps.executionEngine]
     * @param {Object} [deps.useCaseService]
     * @param {Object} deps.folderService
     * @param {Function} [deps.modelValidator]
     * @param {Object|null} [deps.redis]
     */
    constructor({ db, executionEngine, useCaseService, folderService, modelValidator = validateModelInputs, redis = undefined }) {
        this.db = db;
        this.executionEngine = executionEngine || useCaseService;
        this.folderService = folderService;
        this.modelValidator = modelValidator;
        this.redis = redis !== undefined ? redis : (envConfig.isTest ? null : redisConnection);
        this._inFlightEditWorkflows = new Set();
    }

    /**
     * Acquires a short-lived exclusive edit lock per workflowId (in-process + Redis NX PX when ready)
     * to prevent concurrent double-click race conditions from creating duplicate placeholders & credit holds.
     */
    async _acquireWorkflowEditLock(workflowId) {
        if (this._inFlightEditWorkflows.has(workflowId)) {
            throw new AppError("An edit is already in progress for this workflow", 409, {
                code: "EDIT_ALREADY_IN_PROGRESS",
            });
        }
        this._inFlightEditWorkflows.add(workflowId);

        const lockKey = `lock:workflow-edit:${workflowId}`;
        const token = randomUUID();
        let redisAcquired = false;

        const canUseRedis =
            this.redis &&
            typeof this.redis.set === "function" &&
            (this.redis.status === undefined || this.redis.status === "ready");

        if (canUseRedis) {
            try {
                const res = await this.redis.set(lockKey, token, "PX", EDIT_LOCK_TTL_MS, "NX");
                if (res !== "OK") {
                    this._inFlightEditWorkflows.delete(workflowId);
                    throw new AppError("An edit is already in progress for this workflow", 409, {
                        code: "EDIT_ALREADY_IN_PROGRESS",
                    });
                }
                redisAcquired = true;
            } catch (err) {
                if (err instanceof AppError) throw err;
                logger.warn(
                    { workflowId, err: err?.message },
                    "Workflow edit Redis lock unavailable; falling back to in-process edit guard"
                );
            }
        }

        return {
            release: async () => {
                this._inFlightEditWorkflows.delete(workflowId);
                if (!redisAcquired) return;
                try {
                    if (typeof this.redis.eval === "function") {
                        await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
                    } else if (typeof this.redis.del === "function") {
                        await this.redis.del(lockKey);
                    }
                } catch (releaseErr) {
                    logger.warn(
                        { workflowId, err: releaseErr?.message },
                        "Failed to release workflow edit Redis lock"
                    );
                }
            },
        };
    }

    /**
     * Safely resolves a model schema if known (unknown models are reported by `this.modelValidator`).
     */
    _getOptionalModelSchema(model) {
        try {
            return getModelSchema(model);
        } catch {
            return null;
        }
    }

    /**
     * Strips secret keys and client batch/override keys before schema validation.
     */
    _filterClientParams(rawParams, extraStripKeys = []) {
        const blockedKeys = extraStripKeys.length > 0
            ? new Set([...CLIENT_BATCH_KEYS, ...extraStripKeys])
            : CLIENT_BATCH_KEYS;
        const filtered = {};
        for (const [k, v] of Object.entries(rawParams || {})) {
            if (!SECRET_PARAM_PATTERN.test(k) && !blockedKeys.has(k)) {
                filtered[k] = v;
            }
        }
        return filtered;
    }

    /**
     * Runs canonical model validation and builds normalized non-prompt parameters.
     */
    _validateAndSanitizeParams({ model, validationInput, omitFromSanitized = [] }) {
        let cleanInput;
        try {
            cleanInput = this.modelValidator(model, validationInput);
        } catch (valErr) {
            const statusCode = valErr.statusCode || 400;
            const appErr = new AppError(valErr.message, statusCode);
            appErr.code = valErr.code || "VALIDATION_ERROR";
            appErr.field = valErr.field;
            throw appErr;
        }

        const omitted = new Set(["prompt", ...omitFromSanitized]);
        const sanitizedParams = {};
        for (const [k, v] of Object.entries(cleanInput)) {
            if (!omitted.has(k)) {
                sanitizedParams[k] = v;
            }
        }
        return { cleanInput, sanitizedParams };
    }

    /**
     * Best-effort placeholder status update during error/billing compensation.
     */
    async _updatePlaceholderStatusSafe(mediaId, status, errorMessage) {
        if (mediaId && this.db?.media?.updateMedia) {
            await this.db.media.updateMedia(mediaId, {
                status,
                error_message: errorMessage,
            }).catch(() => {});
        }
    }

    /**
     * Launches a V3 workflow via ExecutionEngine and applies consistent billing ("saved")
     * and queue dispatch failure (503 + "failed" placeholder) compensation.
     */
    async _launchWithBillingCompensation({
        useCaseId,
        runtimeInput,
        userId,
        workflowId,
        mediaId,
        serverMediaIds,
        projectId,
        label = "workflow",
        logMeta = {},
    }) {
        let taskId = null;
        let hasSufficientCredits = true;
        let creditErrorMsg = null;
        let calculatedCost = null;

        try {
            logger.debug({ workflowId, mediaId, useCase: useCaseId }, `Launching ${label} via ExecutionEngine`);
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
            logger.info(
                { calculatedCost, taskId, workflowId, mediaId, ...logMeta },
                `Reserved ${calculatedCost} credits & enqueued ${label} job "${taskId}"`
            );
        } catch (serviceErr) {
            if (BILLING_ERROR_CODES.has(serviceErr.code)) {
                hasSufficientCredits = false;
                creditErrorMsg = serviceErr.message;
                logger.warn({ workflowId, mediaId, code: serviceErr.code }, `Billing error: ${serviceErr.message}`);
            } else if (serviceErr.code === "QUEUE_DISPATCH_FAILED") {
                logger.error({ workflowId, mediaId, code: serviceErr.code }, `Queue dispatch failed: ${serviceErr.message}`);
                await this._updatePlaceholderStatusSafe(mediaId, "failed", serviceErr.message);
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

        if (!hasSufficientCredits) {
            await this._updatePlaceholderStatusSafe(mediaId, "saved", creditErrorMsg || "Insufficient credits");
        }

        return { taskId, hasSufficientCredits, creditErrorMsg, calculatedCost };
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
            const schema = this._getOptionalModelSchema(model);
            if (schema?.parameters?.aspect_ratio) {
                resolvedParams.aspect_ratio = mediaMeta.aspect_ratio;
            }
        }

        // 2b-4. Strip secrets & client batch params, validate against schema, and build config
        const trimmedPrompt = (prompt || "").trim();
        const preValidationParams = this._filterClientParams(resolvedParams);
        const { cleanInput, sanitizedParams } = this._validateAndSanitizeParams({
            model,
            validationInput: { prompt: trimmedPrompt, ...preValidationParams },
        });

        const initialGenerationConfig = {
            prompt: cleanInput.prompt || trimmedPrompt,
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
                prompt: cleanInput.prompt || trimmedPrompt,
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
            const { taskId, hasSufficientCredits, creditErrorMsg, calculatedCost } =
                await this._launchWithBillingCompensation({
                    useCaseId,
                    runtimeInput,
                    userId,
                    workflowId,
                    mediaId,
                    serverMediaIds,
                    projectId,
                    label: "workflow",
                });

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
            if (err.code !== "QUEUE_DISPATCH_FAILED") {
                await this._updatePlaceholderStatusSafe(
                    mediaId,
                    "failed",
                    err.message || `Failed to prepare ${mediaType} generation request`
                );
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
     * Checks whether a media record is a valid, completed HTTP(S) asset eligible as an edit source.
     */
    _isValidEditableMedia(media) {
        return Boolean(
            media &&
            media.status === "success" &&
            typeof media.url === "string" &&
            (media.url.startsWith("http://") || media.url.startsWith("https://"))
        );
    }

    /**
     * Resolves the source media to edit on `workflowId`.
     *
     * Rules (Problem #2 — non-bricking fallback while keeping failed/saved media as `is_primary`):
     *   1. If the current `is_primary` media is `processing`/`pending` -> 409 PRIMARY_MEDIA_NOT_READY.
     *   2. If the current `is_primary` media is `success` with a valid HTTP(S) `url` -> use it directly.
     *   3. If the current `is_primary` media is `failed` or `saved` (or `url: null`), keep it as primary
     *      and fall back within the SAME `workflow_id`:
     *        a) First check its `generation_config.source_media_id` if present on this workflow and valid `success`.
     *        b) Otherwise select the latest completed `status === "success"` media with a valid HTTP(S) `url`.
     *   4. Only throw 400 PRIMARY_MEDIA_INVALID if the workflow has zero valid completed media.
     */
    async _resolveEditableSourceMedia(workflowId) {
        const hydrateItem = async (item) => {
            if (!item) return null;
            if (item.status !== undefined && item.url !== undefined) {
                return item;
            }
            const itemId = item.id || item.media_id;
            if (itemId && typeof this.db?.media?.findById === "function") {
                const full = await this.db.media.findById(itemId).catch(() => null);
                if (full) {
                    return { ...item, ...full, id: full.id || itemId };
                }
            }
            return item;
        };

        const rawPrimaryMedia = typeof this.db?.workflowMedia?.getPrimaryMedia === "function"
            ? await this.db.workflowMedia.getPrimaryMedia(workflowId)
            : null;
        const primaryMedia = await hydrateItem(rawPrimaryMedia);

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

        if (this._isValidEditableMedia(primaryMedia)) {
            return primaryMedia;
        }

        // Load workflow's media history for safe in-workflow fallback resolution
        let rawWorkflowItems = null;
        if (typeof this.db?.workflowMedia?.findByWorkflow === "function") {
            rawWorkflowItems = await this.db.workflowMedia.findByWorkflow(workflowId);
        } else if (typeof this.db?.media?.findByWorkflow === "function") {
            rawWorkflowItems = await this.db.media.findByWorkflow(workflowId);
        }

        const refSourceId =
            typeof primaryMedia.generation_config?.source_media_id === "string" &&
            primaryMedia.generation_config.source_media_id.trim()
                ? primaryMedia.generation_config.source_media_id.trim()
                : null;

        if (Array.isArray(rawWorkflowItems) && rawWorkflowItems.length > 0) {
            const hydratedItems = [];
            for (const item of rawWorkflowItems) {
                const hydrated = await hydrateItem(item);
                if (hydrated) hydratedItems.push(hydrated);
            }

            // (a) Prefer the failed/saved primary's own source_media_id if it belongs to this workflow and is valid
            if (refSourceId) {
                const directSource = hydratedItems.find(
                    (m) => (m.id || m.media_id) === refSourceId && m.role !== "reference"
                );
                if (this._isValidEditableMedia(directSource)) {
                    logger.info(
                        {
                            workflowId,
                            primaryMediaId: primaryMedia.id || primaryMedia.media_id,
                            primaryStatus: primaryMedia.status,
                            fallbackSourceMediaId: directSource.id || directSource.media_id,
                        },
                        "Primary media is not editable; falling back to its source_media_id on the same workflow"
                    );
                    return directSource;
                }
            }

            // (b) Otherwise select the latest completed valid non-reference media on this workflow
            //     (repositories return created_at ASC; scan newest -> oldest)
            for (let i = hydratedItems.length - 1; i >= 0; i--) {
                const candidate = hydratedItems[i];
                if (candidate.role === "reference") continue;
                if (this._isValidEditableMedia(candidate)) {
                    logger.info(
                        {
                            workflowId,
                            primaryMediaId: primaryMedia.id || primaryMedia.media_id,
                            primaryStatus: primaryMedia.status,
                            fallbackSourceMediaId: candidate.id || candidate.media_id,
                        },
                        "Primary media is not editable; falling back to latest completed media on the same workflow"
                    );
                    return candidate;
                }
            }
        }

        throw new AppError("Primary media is not in a valid completed state for editing", 400, {
            code: "PRIMARY_MEDIA_INVALID",
        });
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
        characters = [],
        elements = [],
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

        const workflowType = String(workflow.workflow_type || workflow.workflowType || "").trim().toUpperCase();
        if (UNEDITABLE_SHEET_WORKFLOW_TYPES.has(workflowType)) {
            throw new AppError(
                `In-place image edits are not supported on "${workflowType}" workflows. Edit generated or uploaded image workflows instead.`,
                400,
                { code: "UNSUPPORTED_WORKFLOW_TYPE" }
            );
        }

        if (await this._isWorkflowTrashed(workflowId, userId)) {
            throw new AppError("Cannot edit media inside a trashed workflow", 409, {
                code: "WORKFLOW_TRASHED",
            });
        }

        const editLock = await this._acquireWorkflowEditLock(workflowId);
        let newMediaId = null;

        try {
            // 2. Server-Resolved Source Media Lookup (with non-bricking fallback when primary is failed/saved)
            const primaryMedia = await this._resolveEditableSourceMedia(workflowId);
            const sourceMediaId = primaryMedia.id || primaryMedia.media_id;

            // Enforce single canonical media-type check before mutating DB/primary or holding credits
            assertAllowedMediaType(primaryMedia, ["image"], sourceMediaId);

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

            const modelSchema = this._getOptionalModelSchema(model);

            const normalizedReferences = Array.isArray(references) ? references : [];
            const normalizedCharacters = Array.isArray(characters) ? characters : [];
            const normalizedElements = Array.isArray(elements) ? elements : [];

            if (!resolvedParams.aspect_ratio) {
                const arDef = modelSchema?.parameters?.aspect_ratio;
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
            } else {
                inheritedAspectRatio = resolvedParams.aspect_ratio;
            }

            const preValidationParams = this._filterClientParams(resolvedParams, ["images", "input_image", "prompt"]);
            const trimmedEditPrompt = (prompt || "").trim();
            const isRemoveBackground = editType === "remove_background";
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
            const { cleanInput, sanitizedParams } = this._validateAndSanitizeParams({
                model,
                validationInput: validationPayload,
                omitFromSanitized: isRemoveBackground ? ["input_image"] : [],
            });

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

            const modelMaxReferences = Number(modelSchema?.parameters?.images?.max);

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

            // 5. Launch V3 Workflow via ExecutionEngine & Apply Billing/Dispatch Compensation
            const runtimeInput = {
                prompt: finalPrompt,
                model,
                source_image_url: primaryMedia.url,
                source_media_id: sourceMediaId,
                aspect_ratio: cleanInput.aspect_ratio || inheritedAspectRatio,
                width,
                height,
                references: normalizedReferences,
                characters: normalizedCharacters,
                elements: normalizedElements,
                ...(Number.isInteger(modelMaxReferences) && modelMaxReferences >= 1
                    ? { max_references: modelMaxReferences }
                    : {}),
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

            const { taskId, hasSufficientCredits, creditErrorMsg, calculatedCost } =
                await this._launchWithBillingCompensation({
                    useCaseId,
                    runtimeInput,
                    userId,
                    workflowId,
                    mediaId: newMediaId,
                    serverMediaIds,
                    projectId: workflow.project_id,
                    label: "image edit workflow",
                    logMeta: { editType },
                });

            // 6. Return DTO
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
            if (err.code !== "QUEUE_DISPATCH_FAILED") {
                await this._updatePlaceholderStatusSafe(
                    newMediaId,
                    "failed",
                    err.message || `Failed to prepare image ${editType} request`
                );
            }
            throw err;
        } finally {
            await editLock.release();
        }
    }
}
