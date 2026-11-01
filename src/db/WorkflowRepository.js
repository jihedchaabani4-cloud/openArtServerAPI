import { BaseRepository } from "./BaseRepository.js";
import { supabase } from "../../lib/supabase.js";
import { trashRepository } from "./TrashRepository.js";
import { createLogger } from "../infrastructure/logging/index.js";

const workflowRepositoryLogger = createLogger("workflow_repository");

export class WorkflowRepository extends BaseRepository {
    constructor() {
        super("workflow");
    }

    /**
     * Creates a workflow (one variation inside a batch, or a standalone upload).
     * Repository-pure: no imports from controller layer.
     * @param {Object} data - workflow fields
     * @param {Object} [options] - extra options (e.g., select)
     */
    async createWorkflow(data, options = {}) {
        const {
            project_id, display_name,
            workflow_type,
        } = data;

        const newWorkflow = {
            project_id:       project_id       || null,
            display_name:     display_name     || "Untitled Workflow",
        };

        if (data.id) newWorkflow.id = data.id;
        if (workflow_type) newWorkflow.workflow_type = workflow_type;
        if (data.folder_id !== undefined) newWorkflow.folder_id = data.folder_id || null;
        if (data.user_id) newWorkflow.user_id = data.user_id;

        const { select = "*" } = options;

        const { data: created, error } = await supabase
            .from(this.tableName)
            .insert(newWorkflow)
            .select(select)
            .single();

        if (error) throw error;
        return created;
    }

    async getWorkflow(id) {
        const { data, error } = await supabase
            .from(this.tableName)
            .select("*")
            .eq("id", id)
            .maybeSingle();
        if (error) throw error;
        return data;
    }

    /**
     * Sets the primary media via workflow_media.is_primary.
     */
    async updatePrimaryMedia(workflow_id, media_id) {
        if (!workflow_id) return;
        if (media_id) {
            const client = this.client();
            // Preferred atomic path: RPC in single transaction with row locking
            if (typeof client.rpc === "function") {
                try {
                    const { data, error } = await client.rpc("set_workflow_primary_media", {
                        p_workflow_id: workflow_id,
                        p_media_id: media_id,
                    });
                    if (!error && data) return data;
                } catch (_) {}
            }

            // Correct sequential fallback: CLEAR PREVIOUS FIRST, SET NEW SECOND
            await client
                .from("workflow_media")
                .update({ is_primary: false })
                .eq("workflow_id", workflow_id)
                .eq("is_primary", true)
                .neq("media_id", media_id);

            const { error: relErr } = await client
                .from("workflow_media")
                .update({ is_primary: true })
                .eq("workflow_id", workflow_id)
                .eq("media_id", media_id);
            if (relErr) {
                await client
                    .from("workflow_media")
                    .upsert({ workflow_id, media_id, role: "output", is_primary: true }, { onConflict: "workflow_id,media_id,role" });
            }
        } else {
            await this.client()
                .from("workflow_media")
                .update({ is_primary: false })
                .eq("workflow_id", workflow_id)
                .eq("is_primary", true);
        }
    }


    async findByProject(project_id, options = {}) {
        const { select = "*", order = { column: "create_time", ascending: false }, partitioned = false } = options;
        let query = supabase.from(this.tableName).select(select);
        if (order) query = query.order(order.column, { ascending: order.ascending });
        query = query.eq("project_id", project_id);
        let { data, error } = await query;
        if (error && typeof select === "string" && select.includes("primary_media_id")) {
            // Graceful resilience: if primary_media_id column was dropped (ADR-0007),
            // retry without primary_media_id rather than failing the entire project read.
            const fallbackSelect = select
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s !== "primary_media_id")
                .join(", ");
            let fallbackQuery = supabase.from(this.tableName).select(fallbackSelect);
            if (order) fallbackQuery = fallbackQuery.order(order.column, { ascending: order.ascending });
            fallbackQuery = fallbackQuery.eq("project_id", project_id);
            const fallbackRes = await fallbackQuery;
            if (!fallbackRes.error) {
                data = fallbackRes.data;
                error = null;
            }
        }
        if (error) throw error;
        const rows = data || [];
        if (!rows.length) {
            return partitioned ? { active: [], trashed: [] } : rows;
        }
        const candidateIds = rows.map((row) => row.id).filter(Boolean);
        let trashedDetailsMap = new Map();
        try {
            trashedDetailsMap = await trashRepository.getTrashedDetailsMap({
                workflowIds: candidateIds,
            });
        } catch (_err) {
            // Graceful resilience: if trash table query fails (e.g. migration not applied),
            // candidate workflows remain active rather than zeroing out the user's project.
            trashedDetailsMap = new Map();
        }

        if (partitioned) {
            const active = [];
            const trashed = [];
            for (const row of rows) {
                const trashInfo = trashedDetailsMap.get(row.id);
                if (trashInfo) {
                    trashed.push({
                        ...row,
                        deleted_at: trashInfo.deleted_at || null,
                    });
                } else {
                    active.push(row);
                }
            }
            return { active, trashed };
        }

        return trashedDetailsMap.size > 0 ? rows.filter((row) => !trashedDetailsMap.has(row.id)) : rows;
    }

    /**
     * Resolves the primary media URL for a workflow.
     */
    async getPrimaryMediaUrl(workflow_id) {
        const media = await this.getPrimaryMedia(workflow_id);
        return media?.url || null;
    }

    async conditionalRestorePrimaryMedia({ workflowId, expectedPrimaryMediaId, restorePrimaryMediaId }) {
        if (!workflowId || !expectedPrimaryMediaId) return { updated: false };
        const client = this.client();
        const { data, error } = await client
            .from(this.tableName)
            .update({ primary_media_id: restorePrimaryMediaId || null })
            .eq("id", workflowId)
            .eq("primary_media_id", expectedPrimaryMediaId)
            .select("id, primary_media_id");
        if (error) throw error;
        return {
            workflowId,
            updated: Array.isArray(data) && data.length > 0,
            data,
        };
    }

    /**
     * Resolves the primary media for a workflow via workflow_media.is_primary.
     */
    async getPrimaryMedia(workflow_id) {
        if (!workflow_id) return null;

        const { data: relationRow, error: relationErr } = await this.client()
            .from("workflow_media")
            .select(`
                workflow_id,
                role,
                created_at,
                is_primary,
                media:media_id (id, url)
            `)
            .eq("workflow_id", workflow_id)
            .eq("is_primary", true)
            .limit(1)
            .maybeSingle();

        if (!relationErr && relationRow?.media) {
            const relationMedia = Array.isArray(relationRow.media) ? relationRow.media[0] : relationRow.media;
            if (relationMedia) {
                return {
                    ...relationMedia,
                    workflow_id,
                    workflowId: workflow_id,
                    role: relationRow.role,
                    mediaRole: relationRow.role,
                    is_primary: true,
                };
            }
        }

        return null;
    }

    async #getProjectTrashedWorkflowIdSet(projectIds) {
        const cleanProjectIds = Array.isArray(projectIds) ? projectIds.filter(Boolean) : [];
        if (!cleanProjectIds.length) return new Set();

        const { data, error } = await this.client()
            .from(this.tableName)
            .select("id")
            .in("project_id", cleanProjectIds);
        if (error) throw error;

        const candidateIds = (data || []).map((row) => row.id).filter(Boolean);
        if (!candidateIds.length) return new Set();

        return trashRepository.getTrashedWorkflowIdSet({
            workflowIds: candidateIds,
            client: this.client(),
        });
    }

    /**
     * Paginated workflow query scoped to multiple project IDs.
     * Returns { workflows, total } for library listing.
     * Used by GenerationService.getUserLibrary.
     */
    async findByProjectsPaginated(projectIds, { limit = 30, offset = 0 } = {}) {
        if (!projectIds || projectIds.length === 0) return { workflows: [], total: 0 };

        const trashedSet = await this.#getProjectTrashedWorkflowIdSet(projectIds);
        const trashedExpr = trashedSet.size > 0 ? `(${[...trashedSet].join(",")})` : null;

        // Total count
        let countQ = this.client()
            .from(this.tableName)
            .select("id", { count: "exact", head: true })
            .in("project_id", projectIds);
        if (trashedExpr) {
            countQ = countQ.not("id", "in", trashedExpr);
        }
        const { count: total, error: countErr } = await countQ;
        if (countErr) throw countErr;

        // Data page
        let dataQ = this.client()
            .from(this.tableName)
            .select("id, project_id, display_name, favorited, workflow_type, create_time")
            .in("project_id", projectIds);
        if (trashedExpr) {
            dataQ = dataQ.not("id", "in", trashedExpr);
        }
        dataQ = dataQ
            .order("create_time", { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);
        const { data: workflows, error: dataErr } = await dataQ;
        if (dataErr) throw dataErr;

        return { workflows: workflows || [], total: total || 0 };
    }

    /**
     * Finds a single workflow by ID, enforcing that it belongs to one of the given projectIds.
     * Ownership-safe single workflow lookup.
     * Used by GenerationService.getWorkflowDetail.
     */
    async findByIdInProjects(workflowId, projectIds) {
        if (!projectIds || projectIds.length === 0) return null;
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("id, project_id, display_name, favorited, workflow_type, create_time")
            .eq("id", workflowId)
            .in("project_id", projectIds)
            .maybeSingle();
        if (error) throw error;
        if (!data) return null;
        const trashedSet = await trashRepository.getTrashedWorkflowIdSet({
            workflowIds: [data.id || workflowId],
            client: this.client(),
        });
        if (trashedSet.has(data.id || workflowId)) return null;
        return data;
    }

    /**
     * Deletes a workflow by ID.
     * Used by GenerationService.deleteGeneration.
     */
    async deleteById(workflowId) {
        const { error } = await this.client()
            .from(this.tableName)
            .delete()
            .eq("id", workflowId);
        if (error) throw error;
    }

    /**
     * Updates a workflow by ID with the provided patch.
     * Used by GenerationService.updateGeneration.
     */
    async updateById(workflowId, patch) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .update(patch)
            .eq("id", workflowId)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * Updates folder_id on a workflow, scoped to its owner and project.
     * @param {string} workflowId
     * @param {string|null} folderId
    /**
     * Updates folder_id for a workflow row strictly scoped by project_id and id.
     * userId and projectId are required.
     * @param {string} workflowId
     * @param {string|null} folderId
     * @param {string} userId
     * @param {string} projectId
     * @returns {Promise<Object>}
     */
    async updateFolderId(workflowId, folderId, userId, projectId) {
        if (!workflowId || !userId || !projectId) {
            throw new Error("workflowId, userId, and projectId are required to update folderId");
        }

        const query = this.client()
            .from(this.tableName)
            .update({ folder_id: folderId, user_id: userId })
            .eq("id", workflowId)
            .eq("project_id", projectId);

        const { data, error } = await query.select().single();
        if (error) {
            if (error.code === "PGRST116") {
                const notFoundErr = new Error(`Workflow ${workflowId} not found in project ${projectId}`);
                notFoundErr.code = "PGRST116";
                notFoundErr.statusCode = 404;
                notFoundErr.errorCode = "NOT_FOUND";
                throw notFoundErr;
            }
            if (error.code === "23503") {
                const fkErr = new Error(`Folder ${folderId} not found in project ${projectId}`);
                fkErr.code = "23503";
                fkErr.statusCode = 404;
                fkErr.errorCode = "NOT_FOUND";
                throw fkErr;
            }
            throw error;
        }
        return data;
    }

    /**
     * Lists workflows in a project with optional folder filtering and cursor-based pagination.
     * Order: newest first (create_time DESC, id DESC).
     *
     * @param {string} projectId
     * @param {Object} options
     * @param {string[]|null} [options.folderIds] - List of folder IDs to filter by
     * @param {boolean} [options.folderIdNull=false] - If true, filter where folder_id IS NULL
     * @param {number} [options.limit=50]
     * @param {Object|null} [options.cursor=null] - { createTime, id }
     * @returns {Promise<Object[]>}
     */
    /**
     * Lists workflow ids in the given folders, scoped to one project.
     * FolderService uses this only through WorkflowService.
     */
    async listIdsByFolderIds({ folderIds, projectId, userId } = {}) {
        if (!projectId || !userId || !Array.isArray(folderIds) || folderIds.length === 0) {
            return [];
        }

        const { data, error } = await this.client()
            .from(this.tableName)
            .select("id")
            .eq("project_id", projectId)
            .in("folder_id", folderIds);

        if (error) throw error;
        return (data || []).map((row) => row.id).filter(Boolean);
    }

    async listProjectAssets(projectId, { folderIds = null, folderIdNull = false, limit = 50, cursor = null } = {}) {
        const trashedSet = await this.#getProjectTrashedWorkflowIdSet([projectId]);
        let query = this.client()
            .from(this.tableName)
            .select("*")
            .eq("project_id", projectId);

        if (trashedSet.size > 0) {
            query = query.not("id", "in", `(${[...trashedSet].join(",")})`);
        }

        if (folderIdNull) {
            query = query.is("folder_id", null);
        } else if (Array.isArray(folderIds)) {
            query = query.in("folder_id", folderIds);
        }

        if (cursor && cursor.createTime && cursor.id) {
            query = query.or(`create_time.lt.${cursor.createTime},and(create_time.eq.${cursor.createTime},id.lt.${cursor.id})`);
        }

        query = query
            .order("create_time", { ascending: false })
            .order("id", { ascending: false })
            .limit(limit + 1);

        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    }
}
