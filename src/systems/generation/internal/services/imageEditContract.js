/**
 * In-Place Image Edit Validation Contract & Prompt Builders
 *
 * Pure validation, normalization, and deterministic prompt construction for
 * server-locked in-place image edits (`relight` and `angles`).
 */

import { AppError } from "#shared";
import { getCatalog, getModelSchema } from "#models/tools";
import { renderTextTemplate } from "../v3/nodes/base/textTemplateNode.js";
import { IMAGE_RELIGHT_PROMPT_TEMPLATE } from "../v3/workflows/imageRelightV3.js";
import { IMAGE_ANGLES_PROMPT_TEMPLATE } from "../v3/workflows/imageAnglesV3.js";

export const IMAGE_EDIT_MODELS = Object.freeze({
    relight: "nanobana_2",
    angles: "nanobana_2",
});

export const REMOVE_BACKGROUND_DOMAIN = "remove_background";
export const DEFAULT_REMOVE_BACKGROUND_MODEL = "bria_remove_background_3_0";
export const DEFAULT_IMAGE_EDIT_MODEL = "nanobana_2";

export function getRemoveBackgroundModels() {
    return getCatalog({ domain: REMOVE_BACKGROUND_DOMAIN, status: "active" });
}

export function getEditableImageModels() {
    return getCatalog({ domain: "image", status: "active" }).filter((m) =>
        Boolean(m.parameters?.input_image || m.parameters?.images)
    );
}

const FORBIDDEN_SOURCE_FIELDS = Object.freeze([
    "image_url",
    "source",
    "input_image",
    "source_url",
]);

const ALLOWED_LIGHT_TYPES = new Set(["soft", "hard"]);
const HEX_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/;
const RAW_HTTP_URL_REGEX = /https?:\/\//i;
const INLINE_ENTITY_TAG_REGEX = /<(character|element):([^>\s]+)>/gi;
const MAX_PROMPT_LENGTH = 2000;

/**
 * Extracts unique inline `<character:id>` and `<element:id>` resource IDs from a prompt.
 *
 * @param {string} prompt
 * @returns {{ characterIds: string[], elementIds: string[] }}
 */
export function extractInlineEntityIds(prompt) {
    const characterIds = [];
    const elementIds = [];
    if (typeof prompt !== "string" || !prompt.includes("<")) {
        return { characterIds, elementIds };
    }
    const seenChars = new Set();
    const seenElems = new Set();
    for (const [, kind, rawId] of prompt.matchAll(INLINE_ENTITY_TAG_REGEX)) {
        const id = rawId.trim();
        if (!id) continue;
        if (kind.toLowerCase() === "character") {
            if (!seenChars.has(id)) {
                seenChars.add(id);
                characterIds.push(id);
            }
        } else if (!seenElems.has(id)) {
            seenElems.add(id);
            elementIds.push(id);
        }
    }
    return { characterIds, elementIds };
}

/**
 * Returns the maximum number of additional reference inputs allowed for an edit model,
 * reserving 1 slot for the primary source image (`@image1`).
 *
 * - Models declaring `parameters.images.max` -> `Math.max(0, images.max - 1)`
 * - Models declaring only `parameters.input_image` (no `images` array) -> `0`
 * - Otherwise -> `null` (unconstrained)
 *
 * @param {Object|null} schema
 * @returns {number|null}
 */
export function getModelMaxEditReferences(schema) {
    const imagesMax = Number(schema?.parameters?.images?.max);
    if (Number.isInteger(imagesMax) && imagesMax >= 1) {
        return Math.max(0, imagesMax - 1);
    }
    if (schema?.parameters?.input_image) {
        return 0;
    }
    return null;
}

function parseResourceIdArray(rawList, { field, invalidCode }) {
    if (rawList === undefined || rawList === null) {
        return [];
    }
    if (!Array.isArray(rawList)) {
        throw badRequest(`${field} must be an array of resource IDs.`, invalidCode, field);
    }
    const seen = new Set();
    const out = [];
    for (const item of rawList) {
        if (typeof item !== "string" || !item.trim()) {
            throw badRequest(`Each entry in ${field} must be a non-empty resource ID string.`, invalidCode, field);
        }
        const trimmed = item.trim();
        if (RAW_HTTP_URL_REGEX.test(trimmed)) {
            throw badRequest(
                `Direct image URLs are not permitted in ${field}. Use resource IDs only.`,
                "DIRECT_URL_NOT_ALLOWED",
                field
            );
        }
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            out.push(trimmed);
        }
    }
    return out;
}

/**
 * Validates that the total number of distinct additional edit references (across `references`,
 * `characters`, `elements`, and inline `<character:id>`/`<element:id>` prompt tags, excluding
 * the target `workflowId` itself) does not exceed `model.parameters.images.max - 1`.
 */
export function assertEditReferenceCap({
    model,
    schema,
    workflowId = null,
    references = [],
    characters = [],
    elements = [],
    prompt = "",
}) {
    const maxAdditionalRefs = getModelMaxEditReferences(schema);
    if (maxAdditionalRefs === null) return;

    const uniqueAdditional = new Set();
    const addCandidate = (id) => {
        if (typeof id !== "string") return;
        const trimmed = id.trim();
        if (!trimmed || (workflowId && trimmed === workflowId)) return;
        uniqueAdditional.add(trimmed);
    };

    for (const r of Array.isArray(references) ? references : []) addCandidate(r);
    for (const c of Array.isArray(characters) ? characters : []) addCandidate(c);
    for (const e of Array.isArray(elements) ? elements : []) addCandidate(e);
    const { characterIds: inlineCharIds, elementIds: inlineElemIds } = extractInlineEntityIds(prompt);
    for (const cId of inlineCharIds) addCandidate(cId);
    for (const eId of inlineElemIds) addCandidate(eId);

    if (uniqueAdditional.size > maxAdditionalRefs) {
        throw badRequest(
            `Model "${model}" supports at most ${maxAdditionalRefs} additional reference${maxAdditionalRefs === 1 ? "" : "s"} for image editing (${maxAdditionalRefs + 1} total images including the source image). Received ${uniqueAdditional.size}.`,
            "TOO_MANY_REFERENCES",
            "references"
        );
    }
}

function badRequest(message, code = "VALIDATION_ERROR", field = null) {
    const err = new AppError(message, 400, { code });
    if (field) {
        err.field = field;
    }
    return err;
}

function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function assertNoRawUrls(value, path = "parameters") {
    if (typeof value === "string") {
        if (RAW_HTTP_URL_REGEX.test(value)) {
            throw badRequest(
                `Parameter "${path}": direct URLs are not permitted. Provide workflow_id only.`,
                "DIRECT_URL_NOT_ALLOWED",
                path
            );
        }
        return;
    }

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            assertNoRawUrls(value[i], `${path}[${i}]`);
        }
        return;
    }

    if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) {
            assertNoRawUrls(nested, `${path}.${key}`);
        }
    }
}

function parseOptionalParameters(rawParameters) {
    if (rawParameters === undefined || rawParameters === null) {
        return {};
    }
    if (!isPlainObject(rawParameters)) {
        throw badRequest("parameters must be a plain object.", "INVALID_PARAMETERS", "parameters");
    }
    assertNoRawUrls(rawParameters, "parameters");
    return { ...rawParameters };
}

function parseOptionalPrompt(rawPrompt) {
    if (rawPrompt === undefined || rawPrompt === null) {
        return "";
    }
    if (typeof rawPrompt !== "string") {
        throw badRequest("prompt must be a string.", "INVALID_PROMPT", "prompt");
    }
    const trimmed = rawPrompt.trim();
    if (trimmed.length > MAX_PROMPT_LENGTH) {
        throw badRequest(
            `prompt must be at most ${MAX_PROMPT_LENGTH} characters.`,
            "PROMPT_TOO_LONG",
            "prompt"
        );
    }
    return trimmed;
}

function parseFiniteNumberInRange(raw, { field, min, max, defaultValue, optional = false }) {
    if (raw === undefined || raw === null || raw === "") {
        return optional ? undefined : defaultValue;
    }
    if (typeof raw === "boolean" || typeof raw === "object") {
        throw badRequest(
            `${field} must be a finite number between ${min} and ${max}.`,
            "INVALID_NUMBER",
            field
        );
    }
    const num = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(num) || num < min || num > max) {
        throw badRequest(
            `${field} must be a finite number between ${min} and ${max}.`,
            "OUT_OF_RANGE",
            field
        );
    }
    return num;
}

/**
 * Validates common rejection rules for all in-place image edit requests.
 * Returns the normalized (trimmed) workflowId string.
 *
 * @param {Object} body
 * @returns {string} normalized workflowId
 */
export function validateCommonEditRejection(body, { allowModel = false } = {}) {
    if (!isPlainObject(body)) {
        throw badRequest("Request body must be a JSON object.", "INVALID_BODY");
    }

    if (
        !allowModel &&
        (
            (body.model !== undefined && body.model !== null) ||
            (body.model_name !== undefined && body.model_name !== null)
        )
    ) {
        throw badRequest(
            "Model selection is server-locked for image editing and cannot be specified by the client.",
            "MODEL_LOCKED",
            "model"
        );
    }

    if (
        (body.media_id !== undefined && body.media_id !== null) ||
        (body.mediaId !== undefined && body.mediaId !== null) ||
        (body.source_media_id !== undefined && body.source_media_id !== null)
    ) {
        throw badRequest(
            "Provide workflow_id only; the server resolves the workflow's primary media automatically.",
            "MEDIA_ID_NOT_ALLOWED",
            "media_id"
        );
    }

    for (const key of FORBIDDEN_SOURCE_FIELDS) {
        if (body[key] !== undefined && body[key] !== null) {
            throw badRequest(
                `Direct image source field "${key}" is not permitted. Provide workflow_id only.`,
                "DIRECT_URL_NOT_ALLOWED",
                key
            );
        }
    }

    parseOptionalParameters(body.parameters);

    const rawWorkflowId = body.workflow_id ?? body.workflowId;
    if (typeof rawWorkflowId !== "string" || !rawWorkflowId.trim()) {
        throw badRequest("workflow_id is required.", "MISSING_WORKFLOW_ID", "workflow_id");
    }

    return rawWorkflowId.trim();
}

/**
 * Builds relative-movement template variables consumed by `image-relight-v3` (`base.text_template`).
 * Optional variables (`rotation_dir`, `tilt_dir`, `distance`, `user_prompt`) are omitted when
 * zero/absent so conditional `{{#var}}...{{/var}}` clauses drop cleanly.
 */
export function buildRelightTemplateVars(editSettings = {}, userPrompt = "") {
    const {
        light_type = "soft",
        brightness = 50,
        color = "#FFFFFF",
        size = 50,
        rotation = 0,
        tilt = 0,
        distance,
    } = editSettings;

    const note = typeof userPrompt === "string" ? userPrompt.trim() : "";
    const hasDistance = distance !== undefined && distance !== null;
    const rot = Number(rotation) || 0;
    const tlt = Number(tilt) || 0;

    return {
        has_settings: true,
        light_type,
        rotation: rot,
        tilt: tlt,
        brightness,
        color,
        size,
        ...(rot !== 0
            ? {
                rotation_abs: Math.abs(rot),
                rotation_dir: rot > 0 ? "to the right" : "to the left",
            }
            : {}),
        ...(tlt !== 0
            ? {
                tilt_abs: Math.abs(tlt),
                tilt_dir: tlt > 0 ? "above" : "below",
            }
            : {}),
        ...(hasDistance ? { distance } : {}),
        ...(note ? { user_prompt: note } : {}),
    };
}

/**
 * Builds relative camera-movement template variables consumed by `image-angles-v3` (`base.text_template`).
 * Treats rotation/tilt/zoom strictly as relative deltas from `@image1`'s current camera viewpoint
 * (never assuming `@image1` is a front view). Zero/absent movements are omitted so their sentences drop.
 */
export function buildAnglesTemplateVars(editSettings = {}, userPrompt = "") {
    const {
        rotation = 0,
        tilt = 0,
        zoom = 0,
    } = editSettings;

    const note = typeof userPrompt === "string" ? userPrompt.trim() : "";
    const rot = Number(rotation) || 0;
    const tlt = Number(tilt) || 0;
    const hasZoom = Number(zoom) > 0;

    return {
        has_settings: true,
        rotation: rot,
        tilt: tlt,
        ...(rot !== 0
            ? {
                rotation_abs: Math.abs(rot),
                rotation_dir: rot > 0 ? "to the right" : "to the left",
            }
            : {}),
        ...(tlt !== 0
            ? {
                tilt_abs: Math.abs(tlt),
                tilt_dir: tlt > 0 ? "upward" : "downward",
            }
            : {}),
        ...(hasZoom ? { zoom } : {}),
        ...(note ? { user_prompt: note } : {}),
    };
}

/**
 * Parses, validates, and normalizes a `POST /api/images/relight` request body.
 *
 * @param {Object} body
 * @returns {{ workflowId: string, editSettings: Object, prompt: string, userPrompt: string, parameters: Object }}
 */
export function parseRelightRequest(body) {
    const workflowId = validateCommonEditRejection(body);

    let lightType = "soft";
    if (body.light_type !== undefined && body.light_type !== null && body.light_type !== "") {
        if (typeof body.light_type !== "string") {
            throw badRequest('light_type must be either "soft" or "hard".', "INVALID_LIGHT_TYPE", "light_type");
        }
        const normalizedLightType = body.light_type.trim().toLowerCase();
        if (!ALLOWED_LIGHT_TYPES.has(normalizedLightType)) {
            throw badRequest('light_type must be either "soft" or "hard".', "INVALID_LIGHT_TYPE", "light_type");
        }
        lightType = normalizedLightType;
    }

    const brightness = parseFiniteNumberInRange(body.brightness, {
        field: "brightness",
        min: 0,
        max: 100,
        defaultValue: 50,
    });

    let color = "#FFFFFF";
    if (body.color !== undefined && body.color !== null && body.color !== "") {
        if (typeof body.color !== "string") {
            throw badRequest('color must be a valid 6-digit hex color like "#FFFFFF".', "INVALID_COLOR", "color");
        }
        const trimmedColor = body.color.trim();
        if (!HEX_COLOR_REGEX.test(trimmedColor)) {
            throw badRequest('color must be a valid 6-digit hex color like "#FFFFFF".', "INVALID_COLOR", "color");
        }
        color = trimmedColor.toUpperCase();
    }

    const size = parseFiniteNumberInRange(body.size, {
        field: "size",
        min: 0,
        max: 100,
        defaultValue: 50,
    });

    const rotation = parseFiniteNumberInRange(body.rotation, {
        field: "rotation",
        min: -180,
        max: 360,
        defaultValue: 0,
    });

    const tilt = parseFiniteNumberInRange(body.tilt, {
        field: "tilt",
        min: -90,
        max: 90,
        defaultValue: 0,
    });

    const distance = parseFiniteNumberInRange(body.distance, {
        field: "distance",
        min: 0,
        max: 100,
        optional: true,
    });

    const userPrompt = parseOptionalPrompt(body.prompt);
    const parameters = parseOptionalParameters(body.parameters);

    const editSettings = {
        light_type: lightType,
        brightness,
        color,
        size,
        rotation,
        tilt,
        ...(distance !== undefined ? { distance } : {}),
    };

    const templateVars = buildRelightTemplateVars(editSettings, userPrompt);

    return {
        workflowId,
        editSettings,
        templateVars,
        prompt: renderTextTemplate(IMAGE_RELIGHT_PROMPT_TEMPLATE, templateVars).text,
        userPrompt,
        parameters,
    };
}

/**
 * Parses, validates, and normalizes a `POST /api/images/angles` request body.
 *
 * @param {Object} body
 * @returns {{ workflowId: string, editSettings: Object, prompt: string, userPrompt: string, parameters: Object }}
 */
export function parseAnglesRequest(body) {
    const workflowId = validateCommonEditRejection(body);

    const rotation = parseFiniteNumberInRange(body.rotation, {
        field: "rotation",
        min: -180,
        max: 360,
        defaultValue: 0,
    });

    const tilt = parseFiniteNumberInRange(body.tilt, {
        field: "tilt",
        min: -90,
        max: 90,
        defaultValue: 0,
    });

    const zoom = parseFiniteNumberInRange(body.zoom, {
        field: "zoom",
        min: 0,
        max: 10,
        defaultValue: 0,
    });

    const userPrompt = parseOptionalPrompt(body.prompt);
    const parameters = parseOptionalParameters(body.parameters);

    if (rotation === 0 && tilt === 0 && zoom === 0 && !userPrompt) {
        throw badRequest(
            "At least one camera angle adjustment (rotation, tilt, zoom) or prompt is required.",
            "NO_OP_CAMERA_ANGLE"
        );
    }

    const editSettings = {
        rotation,
        tilt,
        zoom,
    };

    const templateVars = buildAnglesTemplateVars(editSettings, userPrompt);

    return {
        workflowId,
        editSettings,
        templateVars,
        prompt: renderTextTemplate(IMAGE_ANGLES_PROMPT_TEMPLATE, templateVars).text,
        userPrompt,
        parameters,
    };
}

/**
 * Parses, validates, and normalizes a `POST /api/images/remove-background` request body.
 * Dynamically resolves any active model registered under the `remove_background` domain
 * via `#models/tools` (zero hardcoded model allowlist) and enforces its manifest schema.
 *
 * @param {Object} body
 * @returns {{ workflowId: string, model: string, editSettings: Object, prompt: string, userPrompt: string, parameters: Object }}
 */
export function parseRemoveBackgroundRequest(body) {
    const workflowId = validateCommonEditRejection(body, { allowModel: true });

    const activeModels = getRemoveBackgroundModels();
    const activeIds = activeModels.map((m) => m.id);

    const rawModel = body.model ?? body.model_name;
    let schema = null;
    if (rawModel !== undefined && rawModel !== null && rawModel !== "") {
        if (typeof rawModel !== "string" || !rawModel.trim()) {
            throw badRequest(
                `model must be one of: ${activeIds.join(", ")}.`,
                "INVALID_MODEL",
                "model"
            );
        }
        try {
            schema = getModelSchema(rawModel.trim());
        } catch {
            schema = null;
        }
        if (!schema || schema.domain !== REMOVE_BACKGROUND_DOMAIN || schema.status !== "active") {
            throw badRequest(
                `Unsupported model "${rawModel.trim()}" for background removal. Allowed models: ${activeIds.join(", ")}.`,
                "INVALID_MODEL",
                "model"
            );
        }
    } else {
        const defaultEntry =
            activeModels.find((m) => m.id === DEFAULT_REMOVE_BACKGROUND_MODEL) || activeModels[0];
        if (!defaultEntry) {
            throw badRequest(
                "No active remove_background models are currently configured.",
                "NO_REMOVE_BACKGROUND_MODELS",
                "model"
            );
        }
        schema = getModelSchema(defaultEntry.id);
    }

    const model = schema.id;
    const modelParams = schema.parameters || {};
    const parameters = parseOptionalParameters(body.parameters);

    const userPrompt = parseOptionalPrompt(body.prompt);
    if (userPrompt && !modelParams.prompt) {
        throw badRequest(
            `prompt is not supported by model "${model}". Select a guided remove_background model or omit prompt.`,
            "PROMPT_NOT_SUPPORTED_FOR_MODEL",
            "prompt"
        );
    }

    const normalizedParameters = { ...parameters };
    const editSettings = { model };

    if (modelParams.preserve_alpha) {
        const rawPreserveAlpha =
            body.preserve_alpha !== undefined ? body.preserve_alpha : parameters.preserve_alpha;
        let preserveAlpha =
            typeof modelParams.preserve_alpha.default === "boolean"
                ? modelParams.preserve_alpha.default
                : true;
        if (rawPreserveAlpha !== undefined && rawPreserveAlpha !== null) {
            if (typeof rawPreserveAlpha !== "boolean") {
                throw badRequest("preserve_alpha must be a boolean.", "INVALID_PRESERVE_ALPHA", "preserve_alpha");
            }
            preserveAlpha = rawPreserveAlpha;
        }
        normalizedParameters.preserve_alpha = preserveAlpha;
        editSettings.preserve_alpha = preserveAlpha;
    }

    return {
        workflowId,
        model,
        editSettings,
        prompt: userPrompt,
        userPrompt,
        parameters: normalizedParameters,
    };
}

/**
 * Parses, validates, and normalizes a `POST /api/images/edit` request body.
 * Dynamically resolves any active edit-capable `image` model (declaring `input_image` or `images`
 * in its manifest schema) via `#models/tools`, requires a non-empty `prompt`, enforces
 * `workflow_id`-only source resolution, and rejects raw URLs in `references` and `parameters`.
 *
 * @param {Object} body
 * @returns {{ workflowId: string, model: string, prompt: string, userPrompt: string, references: string[], editSettings: Object, parameters: Object }}
 */
export function parseImageEditRequest(body) {
    const workflowId = validateCommonEditRejection(body, { allowModel: true });

    const prompt = parseOptionalPrompt(body.prompt);
    if (!prompt) {
        throw badRequest("prompt is required for image editing.", "MISSING_PROMPT", "prompt");
    }

    const editableModels = getEditableImageModels();
    const editableIds = editableModels.map((m) => m.id);

    const rawModel = body.model ?? body.model_name;
    let schema = null;
    if (rawModel !== undefined && rawModel !== null && rawModel !== "") {
        if (typeof rawModel !== "string" || !rawModel.trim()) {
            throw badRequest(
                `model must be an edit-capable image model: ${editableIds.join(", ")}.`,
                "INVALID_MODEL",
                "model"
            );
        }
        try {
            schema = getModelSchema(rawModel.trim());
        } catch {
            schema = null;
        }
        const isEditable = Boolean(
            schema &&
            schema.domain === "image" &&
            schema.status === "active" &&
            (schema.parameters?.input_image || schema.parameters?.images)
        );
        if (!isEditable) {
            throw badRequest(
                `Model "${rawModel.trim()}" does not support image editing. Supported edit models: ${editableIds.join(", ")}.`,
                "MODEL_NOT_EDIT_CAPABLE",
                "model"
            );
        }
    } else {
        const defaultEntry =
            editableModels.find((m) => m.id === DEFAULT_IMAGE_EDIT_MODEL) || editableModels[0];
        if (!defaultEntry) {
            throw badRequest(
                "No active edit-capable image models are currently configured.",
                "NO_EDIT_MODELS",
                "model"
            );
        }
        schema = getModelSchema(defaultEntry.id);
    }

    const references = parseResourceIdArray(body.references, {
        field: "references",
        invalidCode: "INVALID_REFERENCES",
    });
    const characters = parseResourceIdArray(body.characters, {
        field: "characters",
        invalidCode: "INVALID_CHARACTERS",
    });
    const elements = parseResourceIdArray(body.elements, {
        field: "elements",
        invalidCode: "INVALID_ELEMENTS",
    });

    const parameters = parseOptionalParameters(body.parameters);
    const model = schema.id;

    assertEditReferenceCap({
        model,
        schema,
        workflowId,
        references,
        characters,
        elements,
        prompt,
    });

    return {
        workflowId,
        model,
        prompt,
        userPrompt: prompt,
        references,
        characters,
        elements,
        editSettings: { model },
        parameters,
    };
}

export default {
    IMAGE_EDIT_MODELS,
    REMOVE_BACKGROUND_DOMAIN,
    DEFAULT_REMOVE_BACKGROUND_MODEL,
    DEFAULT_IMAGE_EDIT_MODEL,
    getRemoveBackgroundModels,
    getEditableImageModels,
    getModelMaxEditReferences,
    assertEditReferenceCap,
    validateCommonEditRejection,
    parseRelightRequest,
    parseAnglesRequest,
    parseRemoveBackgroundRequest,
    parseImageEditRequest,
};
