/**
 * ElementRepository
 * Low-level Supabase persistence for the `element` table.
 *
 * buildPatch() — strict whitelist: only explicitly provided fields are included.
 * Reads by element.id OR element.workflow_id via resolveRecord().
 *
 * Feature: 018-element-reference-system
 */

import { supabase } from "../../lib/supabase.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize guidelines to a plain string.
 * Accepts: string | string[] | null | undefined.
 */
function normalizeGuidelines(value) {
    if (value === undefined) return undefined;
    if (value === null)      return "";
    if (Array.isArray(value)) {
        return value.map((g) => String(g).trim()).filter(Boolean).join("\n");
    }
    return String(value).trim();
}

/**
 * Build a strict partial-update patch — only fields present in `updates` are included.
 * Allowed writable fields: name, description, guidelines, workflow_id, primary_media_id, element_type, source_images.
 */
function buildPatch(updates = {}) {
    const patch = {};

    if (updates.name !== undefined) {
        patch.name = String(updates.name || "").replace(/^@+/, "").trim();
    }
    if (updates.description !== undefined) {
        patch.description = updates.description == null
            ? null
            : String(updates.description).trim() || null;
    }
    if (updates.guidelines !== undefined) {
        patch.guidelines = normalizeGuidelines(updates.guidelines);
    }
    if (updates.element_type !== undefined) {
        patch.element_type = updates.element_type;
    }
    if (updates.source_images !== undefined) {
        patch.source_images = updates.source_images;
    }
    if (updates.workflow_id !== undefined) {
        patch.workflow_id = updates.workflow_id;
    }
    if (updates.primary_media_id !== undefined) {
        patch.primary_media_id = updates.primary_media_id;
    }

    return patch;
}

// ─── Repository class ──────────────────────────────────────────────────────────

export class ElementRepository {

    // ── Reads ──────────────────────────────────────────────────────────────────

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
        const { data: workflows, error: wfErr } = await supabase
            .from("workflow")
            .select("id")
            .eq("project_id", projectId);
        if (wfErr) throw wfErr;

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

        const { data: workflows, error: wfErr } = await supabase
            .from("workflow")
            .select("id")
            .eq("project_id", projectId);
        if (wfErr) throw wfErr;

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

    /**
     * Resolve by element.id or workflow_id — tries both if the value is a UUID.
     */
    async resolveRecord(idOrWorkflowId) {
        if (UUID_RE.test(String(idOrWorkflowId))) {
            return (
                (await this.findById(idOrWorkflowId)) ||
                (await this.findByWorkflowId(idOrWorkflowId))
            );
        }
        return this.findByWorkflowId(idOrWorkflowId);
    }

    // ── Writes ─────────────────────────────────────────────────────────────────

    async create(payload) {
        const insertPayload = {
            guidelines:    "",
            source_images: [],
            ...buildPatch(payload),
            // Pass through fields not covered by buildPatch whitelist
            ...(payload.element_type ? { element_type: payload.element_type } : {}),
            ...(payload.source_images ? { source_images: payload.source_images } : {}),
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

        if (UUID_RE.test(String(idOrWorkflowId))) {
            query = query.or(`id.eq.${idOrWorkflowId},workflow_id.eq.${idOrWorkflowId}`);
        } else {
            query = query.eq("workflow_id", idOrWorkflowId);
        }

        const { data, error } = await query.select();
        if (error) {
            console.error(`[ElementRepository] update error for ${idOrWorkflowId}:`, error);
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

    async deleteById(idOrWorkflowId) {
        let query = supabase.from("element").delete();

        if (UUID_RE.test(String(idOrWorkflowId))) {
            query = query.or(`id.eq.${idOrWorkflowId},workflow_id.eq.${idOrWorkflowId}`);
        } else {
            query = query.eq("workflow_id", idOrWorkflowId);
        }

        const { data, error } = await query.select();
        if (error) {
            console.error(`[ElementRepository] deleteById error for ${idOrWorkflowId}:`, error);
            throw error;
        }
        return data?.[0] || null;
    }
}

export const elementRepository = new ElementRepository();
export default elementRepository;
