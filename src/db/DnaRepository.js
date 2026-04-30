import { BaseRepository } from "./BaseRepository.js";

/**
 * DnaRepository — CRUD for the `dna` table.
 *
 * Table schema:
 *   id                  uuid PK
 *   generation_config_id uuid FK → generation_config(id)
 *   name                text
 *   type                text   (e.g. "CHARACTER")
 *   description         text
 *   traits              jsonb
 *   create_time         timestamptz
 *
 * Join chain to reach DNA from workflow:
 *   workflow → media (primary_media_id) → generation_config → dna
 */
export class DnaRepository extends BaseRepository {
  constructor() {
    super("dna");
  }

  // ─────────────────────────────────────────────────────────
  // createDna
  // ─────────────────────────────────────────────────────────
  async createDna({ generation_config_id, name, type, description = null, traits = {} }) {
    const { data, error } = await this.client()
      .from(this.tableName)
      .insert({ generation_config_id, name, type, description, traits })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ─────────────────────────────────────────────────────────
  // findByConfig
  // ─────────────────────────────────────────────────────────
  async findByConfig(generation_config_id) {
    const { data, error } = await this.client()
      .from(this.tableName)
      .select("*")
      .eq("generation_config_id", generation_config_id)
      .order("create_time", { ascending: true });
    if (error) throw error;
    return data;
  }

  // ─────────────────────────────────────────────────────────
  // updateDescription
  // ─────────────────────────────────────────────────────────
  async updateDescription(id, description) {
    const { data, error } = await this.client()
      .from(this.tableName)
      .update({ description })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  // ─────────────────────────────────────────────────────────
  // getByWorkflowId 🔥 FIXED
  //
  // Join chain:
  //   workflow (primary_media_id)
  //     → media (generation_config_id)
  //       → generation_config (id)
  //         → dna (generation_config_id)
  //
  // Steps:
  //   1. Get workflow → primary_media_id
  //   2. Get media    → generation_config_id
  //   3. Get dna      → by generation_config_id
  //
  // Returns: { character_name, dna, description, type } | null
  // ─────────────────────────────────────────────────────────
  async getByWorkflowId(workflowId) {
    try {

      // ── Step 1: Get workflow → primary_media_id ────────────
      const { data: workflow, error: wfError } = await this.client()
        .from("workflow")
        .select("id, primary_media_id")
        .eq("id", workflowId)
        .single();

      if (wfError || !workflow?.primary_media_id) {
        console.log(`[DnaRepository] No primary_media_id for workflow: ${workflowId}`);
        return null;
      }

      // ── Step 2: Get media → generation_config_id ──────────
      const { data: media, error: mediaError } = await this.client()
        .from("media")
        .select("id, generation_config_id")
        .eq("id", workflow.primary_media_id)
        .single();

      if (mediaError || !media?.generation_config_id) {
        console.log(`[DnaRepository] No generation_config_id for media: ${workflow.primary_media_id}`);
        return null;
      }

      // ── Step 3: Get dna → by generation_config_id ─────────
      const { data: dnaRecords, error: dnaError } = await this.client()
        .from("dna")
        .select("id, name, type, description, traits")
        .eq("generation_config_id", media.generation_config_id)
        .order("create_time", { ascending: true })
        .limit(1);

      if (dnaError || !dnaRecords?.length) {
        console.log(`[DnaRepository] No DNA for config: ${media.generation_config_id}`);
        return null;
      }

      const dna = dnaRecords[0];

      // ── Clean traits — remove null/empty values ────────────
      const cleanedTraits = dna.traits && typeof dna.traits === "object"
        ? Object.fromEntries(
            Object.entries(dna.traits).filter(([_, v]) => v != null && v !== "")
          )
        : {};

      return {
        character_name: dna.name       || null,
        type:           dna.type       || "CHARACTER",
        description:    dna.description || null,
        dna:            Object.keys(cleanedTraits).length > 0 ? cleanedTraits : null,
      };

    } catch (err) {
      console.error(`[DnaRepository] getByWorkflowId error for ${workflowId}:`, err.message);
      return null;
    }
  }
}