import { supabase } from "../../lib/supabase.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeKeywords(keywords) {
    if (keywords === undefined) return undefined;
    if (!Array.isArray(keywords)) return [];

    const seen = new Set();
    return keywords
        .map((k) => String(k).toLowerCase().trim().replace(/^#/, ""))
        .filter((k) => k && !seen.has(k) && seen.add(k));
}

function sanitizeGuidelines(guidelines) {
    if (guidelines === undefined) return undefined;
    if (!Array.isArray(guidelines)) return [];

    return guidelines
        .map((g) => String(g).trim())
        .filter(Boolean);
}

function buildPatch(updates = {}) {
    const patch = { ...updates };

    if (patch.keywords !== undefined) {
        patch.keywords = sanitizeKeywords(patch.keywords);
    }

    if (patch.guidelines !== undefined) {
        patch.guidelines = sanitizeGuidelines(patch.guidelines);
    }

    if (patch.description !== undefined) {
        patch.description = patch.description == null ? null : String(patch.description).trim() || null;
    }

    if (patch.name !== undefined) {
        patch.name = String(patch.name || "").trim();
    }

    return patch;
}

export class ElementRepository {
    async findById(id) {
        const { data, error } = await supabase
            .from("element")
            .select("*")
            .eq("id", id)
            .maybeSingle();

        if (error) throw error;
        return data || null;
    }

    async findByWorkflowId(workflowId) {
        const { data, error } = await supabase
            .from("element")
            .select("*")
            .eq("workflow_id", workflowId)
            .maybeSingle();

        if (error) throw error;
        return data || null;
    }

    async findByName(name, projectId) {
        const { data: workflows, error: workflowError } = await supabase
            .from("workflow")
            .select("id")
            .eq("project_id", projectId);

        if (workflowError) throw workflowError;

        const workflowIds = (workflows || []).map((w) => w.id);
        if (!workflowIds.length) return null;

        const { data, error } = await supabase
            .from("element")
            .select("*")
            .in("workflow_id", workflowIds)
            .ilike("name", name)
            .maybeSingle();

        if (error) throw error;
        return data || null;
    }

    async list({ projectId }) {
        if (!projectId) return [];

        const { data: workflows, error: workflowError } = await supabase
            .from("workflow")
            .select("id")
            .eq("project_id", projectId);

        if (workflowError) throw workflowError;

        const workflowIds = (workflows || []).map((w) => w.id);
        if (!workflowIds.length) return [];

        const { data, error } = await supabase
            .from("element")
            .select("*")
            .in("workflow_id", workflowIds)
            .order("create_time", { ascending: false });

        if (error) throw error;
        return data || [];
    }

    async create(payload) {
        const insertPayload = {
            keywords: [],
            guidelines: [],
            tags: [],
            source_images: [],
            ...buildPatch(payload),
        };

        const { data, error } = await supabase
            .from("element")
            .insert(insertPayload)
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    async update(idOrWorkflowId, updates) {
        const patch = buildPatch(updates);
        if (!Object.keys(patch).length) {
            return this.resolveRecord(idOrWorkflowId);
        }

        let query = supabase.from("element").update(patch);

        if (UUID_REGEX.test(String(idOrWorkflowId))) {
            query = query.or(`id.eq.${idOrWorkflowId},workflow_id.eq.${idOrWorkflowId}`);
        } else {
            query = query.eq("workflow_id", idOrWorkflowId);
        }

        const { data, error } = await query.select();
        if (error) {
            console.error(`[ElementRepository] update error for id ${idOrWorkflowId}:`, error);
            throw error;
        }
        return data?.[0] || null;
    }

    async updateByWorkflowId(workflowId, updates) {
        const existing = await this.findByWorkflowId(workflowId);
        if (!existing) {
            const err = new Error(`Element not found for workflow: ${workflowId}`);
            err.statusCode = 404;
            throw err;
        }

        return this.update(existing.id, updates);
    }

    async resolveRecord(idOrWorkflowId) {
        if (UUID_REGEX.test(String(idOrWorkflowId))) {
            return (await this.findById(idOrWorkflowId)) || (await this.findByWorkflowId(idOrWorkflowId));
        }

        return this.findByWorkflowId(idOrWorkflowId);
    }
}

export const elementRepository = new ElementRepository();
export default elementRepository;
