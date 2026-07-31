import { randomUUID } from "node:crypto";
import { db, workflowStorageGateway } from "../src/container.js";
import { supabase, supabaseAdmin } from "../lib/supabase.js";
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
        const { mediaId: inputMediaId, media_id, imageUrl, projectId } = req.body;
        const userId = req.user.id;
        const targetMediaId = inputMediaId || media_id;

        if (!characterId) return res.status(400).json({ ok: false, message: "characterId is required" });
        if (!targetMediaId && !imageUrl) return res.status(400).json({ ok: false, message: "Either mediaId or imageUrl is required" });

        // ── Step 1: Verify character workflow exists ──────────────────────────
        const { data: wf, error: wfErr } = await supabaseAdmin
            .from("workflow")
            .select("id, project_id")
            .eq("id", characterId)
            .maybeSingle();

        if (wfErr || !wf) return res.status(404).json({ ok: false, message: "Character workflow not found" });

        let resolvedUrl = imageUrl;
        let resolvedWidth = 1024;
        let resolvedHeight = 1024;

        // ── Step 2: If mediaId is provided, fetch media record from DB ───────
        if (targetMediaId) {
            console.log(`🔍 [characterController] Fetching media record from DB for mediaId: ${targetMediaId}`);
            const { data: sourceMedia, error: sourceErr } = await supabaseAdmin
                .from("media")
                .select("*")
                .eq("id", targetMediaId)
                .maybeSingle();

            if (sourceErr || !sourceMedia) {
                return res.status(404).json({ ok: false, message: `Media with ID ${targetMediaId} not found in database` });
            }

            resolvedUrl = sourceMedia.url;
            resolvedWidth = sourceMedia.width || 1024;
            resolvedHeight = sourceMedia.height || 1024;
            console.log(`✅ [characterController] Retrieved URL for mediaId ${targetMediaId} from DB: ${resolvedUrl}`);
        } else if (imageUrl.startsWith("data:")) {
            // base64 Data URL — upload directly to storage
            const newMediaId = randomUUID();
            const ext = imageUrl.startsWith("data:image/png") ? "png" : imageUrl.startsWith("data:image/webp") ? "webp" : "jpg";
            const storagePath = `character-details/${userId}/${characterId}/${newMediaId}.${ext}`;
            resolvedUrl = await storageService.upload(storagePath, imageUrl);
        }

        // ── Step 3: Create media record linked to this character workflow ─────
        const newRecordId = randomUUID();
        const { data: mediaRow, error: mediaErr } = await supabaseAdmin.from("media").insert({
            id:          newRecordId,
            workflow_id: wf.id,
            project_id:  wf.project_id || projectId,
            url:         resolvedUrl,
            step_id:     "character_detail",
            width:       resolvedWidth,
            height:      resolvedHeight,
            status:      "success",
        }).select().single();

        if (mediaErr) {
            console.error("[characterController] addMediaToCharacter DB error:", mediaErr);
            return res.status(500).json({ ok: false, message: mediaErr.message });
        }

        return res.json({ ok: true, media: { ...mediaRow, url: resolvedUrl } });
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

/**
 * PATCH /api/characters/:characterId
 * Unified dedicated API endpoint to update any field of a Character:
 * - name / title / display_name
 * - description / character_info
 * - turnaround_url / body_sheet_url
 * - avatar_url
 * - archetype / gender / style / traits / keywords / guidelines / metadata / more_details
 */
export async function updateCharacter(req, res) {
    try {
        const { characterId } = req.params;
        const userId = req.user?.id;
        const body = req.body || {};

        console.log(`\n======================================================`);
        console.log(`📡 [characterController] PATCH /api/characters/${characterId} received`);
        console.log(`👤 User ID: ${userId || "Unauthenticated"}`);
        console.log(`📦 Payload:`, JSON.stringify(body, null, 2));

        if (!characterId) {
            return res.status(400).json({ ok: false, message: "characterId is required" });
        }

        const charUpdates = { updated_at: new Date().toISOString() };
        const wfUpdates = {};

        // 1. Name & Title (Security: CANNOT be empty! If empty, revert/keep existing DB name)
        const nameVal = body.name || body.title || body.display_name;
        if (nameVal !== undefined) {
            const cleanName = String(nameVal || "").replace(/^@+/, "").trim();
            if (cleanName.length > 0) {
                charUpdates.name = cleanName;
                charUpdates.title = cleanName;
                wfUpdates.display_name = cleanName;
            } else {
                console.warn(`⚠️ [characterController] Empty character name received in payload. Reverting to existing DB name.`);
                const { data: existingChar } = await supabaseAdmin
                    .from("characters")
                    .select("name, title")
                    .or(`id.eq.${characterId},workflow_id.eq.${characterId}`)
                    .maybeSingle();
                const fallbackName = existingChar?.name || existingChar?.title || "Untitled Character";
                charUpdates.name = fallbackName;
                charUpdates.title = fallbackName;
                wfUpdates.display_name = fallbackName;
            }
        }

        // 2. Description & Character Info (CAN be empty string "")
        const descVal = body.description !== undefined ? body.description : body.character_info;
        if (descVal !== undefined) {
            const cleanDesc = String(descVal || "").trim();
            charUpdates.description = cleanDesc;
            charUpdates.character_info = cleanDesc;
        }

        // 3. Turnaround / Body Sheet URL
        const turnaroundVal = body.turnaround_url || body.body_sheet_url;
        if (turnaroundVal !== undefined) {
            charUpdates.turnaround_url = turnaroundVal;
        }

        // 4. Avatar URL
        if (body.avatar_url !== undefined) {
            charUpdates.avatar_url = body.avatar_url;
        }

        // 5. Archetype, Gender, Style
        if (body.archetype !== undefined) charUpdates.archetype = body.archetype;
        if (body.gender !== undefined)    charUpdates.gender = body.gender;
        if (body.style !== undefined)     charUpdates.style = body.style;

        // 6. Traits / Keywords / Guidelines / More Details
        if (body.traits !== undefined)       charUpdates.traits = body.traits;
        if (body.keywords !== undefined)     charUpdates.keywords = body.keywords;
        if (body.guidelines !== undefined)   charUpdates.guidelines = body.guidelines;
        if (body.more_details !== undefined) charUpdates.traits = { ...(charUpdates.traits || {}), more_details: body.more_details };

        // 7. Status & Favorited
        if (body.status !== undefined)       charUpdates.status = body.status;
        if (body.is_favorited !== undefined) charUpdates.is_favorited = !!body.is_favorited;
        if (body.favorited !== undefined)    charUpdates.is_favorited = !!body.favorited;

        console.log(`🔄 [characterController] Updating 'public.characters' table with:`, charUpdates);

        // Update public.characters table
        let { data: updatedChar, error: charErr } = await supabaseAdmin
            .from("characters")
            .update(charUpdates)
            .or(`id.eq.${characterId},workflow_id.eq.${characterId}`)
            .select()
            .maybeSingle();

        if (charErr) {
            console.warn(`⚠️ [characterController] 'characters' update notice:`, charErr.message);
        }

        // If no row existed in public.characters table yet for this character/workflow ID, UPSERT it!
        if (!updatedChar) {
            console.log(`ℹ️ [characterController] No existing row in 'public.characters' table, upserting new row for characterId ${characterId}...`);

            const { data: wfRow } = await supabaseAdmin
                .from("workflow")
                .select("id, project_id, user_id")
                .eq("id", characterId)
                .maybeSingle();

            const insertPayload = {
                id: characterId,
                workflow_id: characterId,
                project_id: wfRow?.project_id || null,
                user_id: userId || wfRow?.user_id || "64950918-266f-42c7-a6d3-c13f87bbbcb8",
                name: charUpdates.name || "Untitled Character",
                title: charUpdates.title || "Untitled Character",
                description: charUpdates.description || "",
                character_info: charUpdates.character_info || "",
                ...charUpdates,
            };

            const { data: insertedChar, error: insertErr } = await supabaseAdmin
                .from("characters")
                .upsert(insertPayload, { onConflict: "id" })
                .select()
                .maybeSingle();

            if (insertErr) {
                console.warn(`⚠️ [characterController] Upsert into 'characters' table notice:`, insertErr.message);
            } else {
                updatedChar = insertedChar;
                console.log(`✅ [characterController] Successfully upserted character row in 'characters' table:`, insertedChar);
            }
        }

        // Update workflow table if display_name is present
        let updatedWf = null;
        if (Object.keys(wfUpdates).length > 0) {
            console.log(`🔄 [characterController] Updating 'workflow' table with:`, wfUpdates);
            const { data: wfRes } = await supabaseAdmin
                .from("workflow")
                .update(wfUpdates)
                .or(`id.eq.${characterId}`)
                .select()
                .maybeSingle();
            updatedWf = wfRes;
        }

        console.log(`✅ [characterController] Character update completed successfully for ID ${characterId}`);
        console.log(`======================================================\n`);

        return res.json({
            ok: true,
            character: updatedChar || { id: characterId, ...charUpdates },
            workflow: updatedWf,
        });

    } catch (err) {
        console.error(`❌ [characterController] updateCharacter error:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}
