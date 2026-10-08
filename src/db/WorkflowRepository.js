import { BaseRepository } from "./BaseRepository.js";
import { supabase } from "../../lib/supabase.js";
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
            project_id, session_id, display_name, primary_media_id,
            variation_index, workflow_type,
        } = data;

        const newWorkflow = {
            project_id:       project_id       || null,
            session_id:       session_id       || null,
            display_name:     display_name     || "Untitled Workflow",
            variation_index:  variation_index  || 0,
            primary_media_id: primary_media_id || null,
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
     * Sets the primary_media_id after the first media is created.
     * Called once per workflow after generation/upload succeeds.
     */
    async updatePrimaryMedia(workflow_id, media_id) {
        const { error } = await supabase
            .from(this.tableName)
            .update({ primary_media_id: media_id })
            .eq("id", workflow_id);
        if (error) throw error;
    }

    async findByBatch(batch_id, options = {}) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("batch_id", batch_id)
            .order("variation_index", { ascending: true });
        if (error) throw error;
        return data;
    }

    async findBySession(session_id, options = {}) {
        const { select = "*", order = { column: "create_time", ascending: false } } = options;
        let query = supabase.from(this.tableName).select(select);
        if (order) query = query.order(order.column, { ascending: order.ascending });
        query = query.eq("session_id", session_id);
        const { data, error } = await query;
        if (error) throw error;
        return data;
    }

    async findByProject(project_id, options = {}) {
        const { select = "*", order = { column: "create_time", ascending: false } } = options;
        let query = supabase.from(this.tableName).select(select);
        if (order) query = query.order(order.column, { ascending: order.ascending });
        query = query.eq("project_id", project_id);
        const { data, error } = await query;
        if (error) throw error;
        return data;
    }

    /**
     * Resolves the primary media URL for a workflow.
     * Logic: primary_media_id > First created media
     */
    async getPrimaryMediaUrl(workflow_id) {
        const media = await this.getPrimaryMedia(workflow_id);
        return media?.url || null;
    }

    /**
     * Resolves the primary media for a workflow.
     * Logic: primary_media_id > First created media
     */
    async getPrimaryMedia(workflow_id) {
        if (!workflow_id) return null;

        // 1. Get workflow to find primary_media_id
        const { data: wf, error: wfErr } = await this.client()
            .from(this.tableName)
            .select("primary_media_id")
            .eq("id", workflow_id)
            .maybeSingle();
        
        if (wfErr) {
            workflowRepositoryLogger.error(
                { workflowId: workflow_id, message: wfErr.message },
                "Error fetching workflow primary media pointer"
            );
            return null;
        }

        if (wf?.primary_media_id) {
            const { data: media, error: mErr } = await this.client()
                .from("media")
                .select("id, url, generation_config_id")
                .eq("id", wf.primary_media_id)
                .maybeSingle();
            if (!mErr && media) return media;
        }

        // 2. Fallback: relation rows created by workflow_media rollout
        const { data: relationRow, error: relationErr } = await this.client()
            .from("workflow_media")
            .select(`
                workflow_id,
                role,
                created_at,
                media:media_id (id, url, generation_config_id)
            `)
            .eq("workflow_id", workflow_id)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (!relationErr) {
            const relationMedia = Array.isArray(relationRow?.media) ? relationRow.media[0] : relationRow?.media;
            if (relationMedia) {
                return {
                    ...relationMedia,
                    workflow_id,
                    workflowId: workflow_id,
                    role: relationRow.role,
                    mediaRole: relationRow.role,
                };
            }
        } else {
            workflowRepositoryLogger.warn(
                { workflowId: workflow_id, message: relationErr.message },
                "workflow_media primary fallback failed; using legacy media.workflow_id"
            );
        }

        // 3. Fallback: find first media created for this workflow
        const { data: firstMedia, error: fErr } = await this.client()
            .from("media")
            .select("id, url, generation_config_id")
            .eq("workflow_id", workflow_id)
            .order("create_time", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (fErr) {
            workflowRepositoryLogger.error(
                { workflowId: workflow_id, message: fErr.message },
                "Error fetching legacy fallback media"
            );
        }

        return firstMedia || null;
    }

    /**
     * Paginated workflow query scoped to multiple project IDs.
     * Returns { workflows, total } for library listing.
     * Used by GenerationService.getUserLibrary.
     */
    async findByProjectsPaginated(projectIds, { sessionId, limit = 30, offset = 0 } = {}) {
        if (!projectIds || projectIds.length === 0) return { workflows: [], total: 0 };

        // Total count
        let countQ = this.client()
            .from(this.tableName)
            .select("id", { count: "exact", head: true })
            .in("project_id", projectIds);
        if (sessionId) countQ = countQ.eq("session_id", sessionId);
        const { count: total, error: countErr } = await countQ;
        if (countErr) throw countErr;

        // Data page
        let dataQ = this.client()
            .from(this.tableName)
            .select("id, project_id, session_id, display_name, variation_index, primary_media_id, favorited, workflow_type, create_time")
            .in("project_id", projectIds)
            .order("create_time", { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);
        if (sessionId) dataQ = dataQ.eq("session_id", sessionId);
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
            .select("id, project_id, session_id, display_name, variation_index, primary_media_id, favorited, workflow_type, create_time")
            .eq("id", workflowId)
            .in("project_id", projectIds)
            .maybeSingle();
        if (error) throw error;
        return data || null;
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
    async listProjectAssets(projectId, { folderIds = null, folderIdNull = false, limit = 50, cursor = null } = {}) {
        let query = this.client()
            .from(this.tableName)
            .select("*")
            .eq("project_id", projectId);

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
