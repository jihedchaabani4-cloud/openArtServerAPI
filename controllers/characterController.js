import { randomUUID } from "node:crypto";
import { db, workflowStorageGateway } from "../src/container.js";
import { supabase } from "../lib/supabase.js";
import { storageService } from "../src/services/StorageService.js";

// V2 Imports
import { loadRegistries } from "../src/v2/registry/registryLoader.js";
import { compileWorkflow } from "../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../src/v2/runner/workflowRunner.js";
import { mapCharacterSheetV1, buildV1CompatibleResponse } from "../src/v2/utils/v1PayloadMapper.js";
import { llmService } from "../src/services/LLMService.js";

let cachedRegistries = null;
function getRegistries() {
    if (!cachedRegistries) cachedRegistries = loadRegistries();
    return cachedRegistries;
}

// ─────────────────────────────────────────────────────────────────────────────
// Character Controller — V2 Engine (character-sheet-v1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/characters/create
 * Creates a new 3-view character workflow with LLM prompt enrichment.
 */
export async function createCharacter(req, res) {
    try {
        const { project_id } = req.body;

        console.log(`\n🚀 [characterController] CREATE CHARACTER request received`);

        if (!project_id) {
            return res.status(400).json({
                ok:      false,
                message: "project_id is required",
            });
        }

        const userId = req.user.id;
        const runId = randomUUID();
        const v2WorkflowId = "character-sheet-v1";
        const v2Input = req.body;

        console.log(`\n================================================================`);
        console.log(`🎭 [character-sheet-v1] USE CASE EXECUTING: CHARACTER SHEET GENERATION`);
        console.log(`📌 Workflow ID: ${v2WorkflowId}`);
        console.log(`📌 Run ID: ${runId}`);
        console.log(`📌 Project ID: ${project_id}`);
        console.log(`📌 User Prompt: "${v2Input.prompt ? v2Input.prompt.slice(0, 120) + '...' : '(No Prompt)'}"`);
        console.log(`📌 Reference Images: ${v2Input.references?.length || 0} attached`);
        console.log(`================================================================\n`);

        const registries = getRegistries();
        const workflowDef = registries.workflows[v2WorkflowId];
        if (!workflowDef) throw new Error(`V2 Workflow ${v2WorkflowId} not found`);
        const plan = compileWorkflow(workflowDef, registries);

        // Phase 1 — Pre-create placeholder
        const placeholder = await workflowStorageGateway.createMediaPlaceholder({
            runId,
            nodeType: "image-generation",
            userId,
            workflowId: v2WorkflowId,
            workflowType: "CHARACTER",
            stepId: "character_sheet",
            input: v2Input,
        });



        const runtimeInput = {
            ...v2Input,
            userId,
            _v1PlaceholderIds: placeholder ? [placeholder] : [],
        };

        console.log(`🚀 [character-sheet-v1] Starting DAG Execution Plan (Run: ${runId})`);
        const runResult = await startWorkflowRun(plan, runtimeInput, runId);

        res.json(buildV1CompatibleResponse({
            runId: runResult.run_id,
            v1WorkflowId: placeholder?.workflowId,
            v1MediaId: placeholder?.mediaId,
            projectId: project_id,
            sessionId: null,
        }));

    } catch (err) {
        console.error(`❌ [characterController] createCharacterSheet error:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

// ─── Character Description Generator ─────────────────────────────────────────

const CHARACTER_GENERATOR_SYSTEM_PROMPT = `
You are an elite haute-couture AI Art Director and Master Character Designer for high-budget cinematic films and editorial fashion houses.
Your task: Given a character concept, archetype, or brief description (such as "The Eccentric", "The Botanical Visionary", "The Wicked", or a custom user prompt), generate an ultra-rich, highly descriptive, editorial character description.

Focus heavily on:
1. Facial geometry, anatomical features, skin texture, and unique biological/sub-dermal details.
2. Architectural hair/headpiece design and editorial posture.
3. Outfit materials, structural tailoring, fabrics (waxy leaves, felted wool, translucent fibers, wet-look surfaces).
4. Cinematic lighting, color mood, and authoritative visual presence.

CRITICAL OUTPUT REQUIREMENT:
You MUST return your response as a valid JSON object with this schema:
{
  "title": "A short 2-4 word evocative character name/title",
  "description": "A 3-5 sentence ultra-detailed, editorial character description ready for high-end AI generation.",
  "keywords": ["5-10 concise factual visual identity keywords"]
}
Do NOT include any markdown code blocks or extra text outside the JSON object.
`;

/**
 * POST /api/character-sheet/generate-description
 * Generates an ultra-detailed, haute-couture editorial character prompt/description from a short brief or archetype.
 */
export async function generateCharacterDescription(req, res) {
    try {
        const { concept, archetype, style } = req.body;
        const inputConcept = concept || archetype || "The Eccentric";

        console.log(`[characterController] Generating editorial character description for: "${inputConcept}"`);

        const promptText = `Generate a masterwork character description for the concept: "${inputConcept}". ${style ? `Incorporate style influences: ${style}.` : ""}`;

        const result = await llmService.generate({
            prompt: promptText,
            systemInstruction: CHARACTER_GENERATOR_SYSTEM_PROMPT,
            jsonMode: true,
        });

        const parsed = result.json || {};
        const description = parsed.description || result.raw || "A visionary character with striking anatomical features and high-fashion editorial presence.";
        const title = parsed.title || inputConcept;
        const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];

        return res.json({
            success: true,
            title,
            description,
            keywords,
            model: result.model,
        });
    } catch (err) {
        console.error("❌ [characterController] generateCharacterDescription error:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
}

export const createCharacterSheet = createCharacter;

// ─── Add Media to Character ───────────────────────────────────────────────────

/**
 * POST /api/characters/:characterId/media
 * Attaches 1-5 user-supplied detail images to an existing character workflow.
 * Stores the image URL in the media table linked to this workflow.
 */
export async function addMediaToCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const { imageUrl, projectId } = req.body;
        const userId = req.user.id;

        if (!characterId) return res.status(400).json({ ok: false, message: "characterId is required" });
        if (!imageUrl)    return res.status(400).json({ ok: false, message: "imageUrl is required" });

        // ── Step 1: Verify character workflow exists ──────────────────────────
        const { data: wf, error: wfErr } = await supabase
            .from("workflow")
            .select("id, project_id")
            .eq("id", characterId)
            .single();

        if (wfErr || !wf) return res.status(404).json({ ok: false, message: "Character workflow not found" });

        // ── Step 2: Upload image to Supabase Storage ──────────────────────────
        // imageUrl can be a base64 Data URL ("data:image/jpeg;base64,...") or a remote URL
        const mediaId   = randomUUID();
        const ext       = imageUrl.startsWith("data:image/png") ? "png"
                        : imageUrl.startsWith("data:image/webp") ? "webp"
                        : "jpg";
        const storagePath = `character-details/${userId}/${characterId}/${mediaId}.${ext}`;

        let publicUrl;
        if (imageUrl.startsWith("data:")) {
            // base64 Data URL — upload directly
            publicUrl = await storageService.upload(storagePath, imageUrl);
        } else {
            // Remote URL — fetch then upload
            publicUrl = await storageService.uploadFromUrl(storagePath, imageUrl);
        }

        console.log(`[characterController] Uploaded character detail image → ${publicUrl}`);

        // ── Step 3: Create media record linked to this character workflow ─────
        const { data: mediaRow, error: mediaErr } = await supabase.from("media").insert({
            id:          mediaId,
            workflow_id: wf.id,
            project_id:  wf.project_id,
            url:         publicUrl,
            step_id:     "character_detail",
            width:       1024,              // ✅ Positive dimensions to satisfy check constraint
            height:      1024,
            status:      "success",
        }).select().single();

        if (mediaErr) {
            console.error("[characterController] addMediaToCharacter DB error:", mediaErr);
            return res.status(500).json({ ok: false, message: mediaErr.message });
        }

        return res.json({ ok: true, media: { ...mediaRow, url: publicUrl } });
    } catch (err) {
        console.error("[characterController] addMediaToCharacter error:", err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * DELETE /api/characters/:characterId/media/:mediaId
 * Removes a detail image from the character.
 */
export async function removeMediaFromCharacter(req, res) {
    try {
        const { characterId, mediaId } = req.params;

        const { error } = await supabase
            .from("media")
            .delete()
            .eq("id", mediaId)
            .eq("workflow_id", characterId);

        if (error) return res.status(500).json({ ok: false, message: error.message });
        return res.json({ ok: true });
    } catch (err) {
        console.error("[characterController] removeMediaFromCharacter error:", err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}
