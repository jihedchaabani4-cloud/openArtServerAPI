/**
 * Internal helper for System 8: Workspace.
 * Batch-fetches lightweight media status records grouped by workflow ID
 * without importing #generation/tools (preserving Rule R14 DAG).
 *
 * Gracefully degrades to empty arrays for legacy hermetic unit tests whose
 * mock `db` omits `media` / `workflowMedia` repositories.
 */

function normalizeWorkflowId(rawId) {
    return String(rawId || "").replace(/^workflows\//, "").trim();
}

function normalizeStatusMap(workflowIds, rawResult) {
    const grouped = new Map(workflowIds.map((id) => [id, []]));

    if (rawResult instanceof Map) {
        for (const [wfId, list] of rawResult.entries()) {
            const clean = normalizeWorkflowId(wfId);
            if (!clean) continue;
            grouped.set(clean, Array.isArray(list) ? list : []);
        }
        return grouped;
    }

    if (Array.isArray(rawResult)) {
        for (const row of rawResult) {
            const wfId = normalizeWorkflowId(row?.workflow_id || row?.workflowId);
            if (!wfId) continue;
            if (!grouped.has(wfId)) grouped.set(wfId, []);
            grouped.get(wfId).push(row);
        }
        return grouped;
    }

    if (rawResult && typeof rawResult === "object") {
        for (const [wfId, list] of Object.entries(rawResult)) {
            const clean = normalizeWorkflowId(wfId);
            if (!clean) continue;
            grouped.set(clean, Array.isArray(list) ? list : []);
        }
    }

    return grouped;
}

/**
 * Fetches media status entries grouped by workflow ID in a single query when available.
 *
 * @param {Object} params
 * @param {string[]} params.workflowIds
 * @param {Object|null} [params.mediaRepo]
 * @param {Object|null} [params.workflowMediaRepo]
 * @returns {Promise<Map<string, Array<{ id?: string, status?: string|null, url?: string|null }>>>}
 */
export async function getMediaStatusesByWorkflowIds({
    workflowIds = [],
    mediaRepo = null,
    workflowMediaRepo = null,
} = {}) {
    const uniqueIds = [...new Set((workflowIds || []).map(normalizeWorkflowId).filter(Boolean))];
    const emptyMap = new Map(uniqueIds.map((id) => [id, []]));
    if (uniqueIds.length === 0) return emptyMap;

    if (typeof workflowMediaRepo?.findMediaStatusesByWorkflowIds === "function") {
        const res = await workflowMediaRepo.findMediaStatusesByWorkflowIds(uniqueIds);
        return normalizeStatusMap(uniqueIds, res);
    }

    if (typeof mediaRepo?.findMediaStatusesByWorkflowIds === "function") {
        const res = await mediaRepo.findMediaStatusesByWorkflowIds(uniqueIds);
        return normalizeStatusMap(uniqueIds, res);
    }

    if (typeof mediaRepo?.findByWorkflow === "function") {
        const lists = await Promise.all(
            uniqueIds.map(async (wfId) => {
                const items = await mediaRepo.findByWorkflow(wfId);
                return [wfId, Array.isArray(items) ? items : []];
            })
        );
        return new Map(lists);
    }

    if (typeof workflowMediaRepo?.findByWorkflowIds === "function") {
        const rows = await workflowMediaRepo.findByWorkflowIds(uniqueIds);
        return normalizeStatusMap(uniqueIds, rows);
    }

    if (typeof workflowMediaRepo?.findByWorkflow === "function") {
        const lists = await Promise.all(
            uniqueIds.map(async (wfId) => {
                const items = await workflowMediaRepo.findByWorkflow(wfId);
                return [wfId, Array.isArray(items) ? items : []];
            })
        );
        return new Map(lists);
    }

    return emptyMap;
}
