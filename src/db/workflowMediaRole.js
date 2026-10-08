export const WORKFLOW_MEDIA_ROLES = Object.freeze([
    "output",
    "original",
    "sheet",
    "detail",
    "reference",
    "avatar",
    "turnaround",
]);

const ROLE_SET = new Set(WORKFLOW_MEDIA_ROLES);

export function normalizeWorkflowMediaRole(role) {
    const normalized = String(role || "").trim().toLowerCase();
    return ROLE_SET.has(normalized) ? normalized : null;
}

export function inferWorkflowMediaRole({ role, stepId, step_id, workflowType, workflow_type } = {}) {
    const explicitRole = normalizeWorkflowMediaRole(role);
    if (explicitRole) return explicitRole;

    const normalizedStep = String(stepId || step_id || "").trim();
    const normalizedType = String(workflowType || workflow_type || "").trim().toUpperCase();

    if (normalizedStep === "upload") return "original";
    if (normalizedStep === "character_sheet") return "sheet";
    if (normalizedStep === "character_detail") return "detail";
    if (normalizedStep === "element_sheet" || normalizedStep === "element_reference") return "detail";
    if (normalizedStep === "image_generation" || normalizedStep === "video_generation") return "output";

    if (normalizedStep === "CAE") {
        if (normalizedType === "UPLOAD") return "original";
        if (["CHARACTER", "CHARACTER_SHEET"].includes(normalizedType)) {
            return "sheet";
        }
        if (["ELEMENT", "ELEMENT_SHEET"].includes(normalizedType)) {
            return "detail";
        }
    }

    if (["ELEMENT", "ELEMENT_SHEET"].includes(normalizedType)) {
        return "detail";
    }

    return "output";
}
