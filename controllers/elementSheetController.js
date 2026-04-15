import { imageTreatment, promptService } from "../src/container.js";

/**
 * Common generator for specialized element sheets.
 * Builds a prompt using LLM, then triggers generation.
 */
async function generateElementSheet(req, res, { systemPrompt, workflowType, defaultModel = "nanobana_pro" }) {
    try {
        const { prompt, features, project_id, session_id, references, model_name } = req.body;
        
        console.log(`\n🚀 [elementSheetController] Received ${workflowType} generation request.`);
        console.log(`📦 [Raw Input]:`, JSON.stringify({ prompt, features, project_id, session_id, model_name }, null, 2));
        console.log(`🖼️ [References Count]: ${references?.length || 0}`);
        
        // Ensure project and session exist
        if (!project_id || !session_id) {
            return res.status(400).json({ ok: false, message: "project_id and session_id are required" });
        }

        // 1. Sanitize the user prompt text by dynamically mapping MediaAsset IDs to <image0> notation
        let cleanTextPrompt = prompt || "Generate a sheet.";
        if (references && references.length > 0) {
            references.forEach((ref, index) => {
                const mediaTag = `<MediaAsset:${ref.media_id || ref.id}>`;
                cleanTextPrompt = cleanTextPrompt.split(mediaTag).join(`<image${index}>`);
            });
            console.log(`🔄 [Sanitization]: Prompt mapped to image notation: "${cleanTextPrompt}"`);
        }

        let userPrompt = `User Prompt: ${cleanTextPrompt}\n`;
        if (features && Object.keys(features).length > 0) {
            userPrompt += `Features selected: ${JSON.stringify(features, null, 2)}`;
        }

        console.log(`\n🧠 [elementSheetController] Sending to LLM for refinement...`);
        console.log(`📝 [LLM System Prompt Snippet]: "${systemPrompt.substring(0, 100)}..."`);
        console.log(`👤 [LLM User Prompt]:`, userPrompt);

        // Use PromptService to refine the prompt
        const refinedPromptText = await promptService.textProvider.complete({
            systemPrompt,
            userPrompt,
            temperature: 0.7
        });

        console.log(`\n✅ [elementSheetController] Received Refined Prompt from LLM:`);
        console.log(`✨ "${refinedPromptText}"`);

        const userId = req.user?.id || 'e54d7d5f-9c49-457d-83b7-ac8484bceb80';

        const aiPayload = {
            prompt: refinedPromptText,
            project_id,
            session_id,
            references,
            model_name: model_name || defaultModel,
            userId,
            quality: "ultra", 
            count: 1          
        };

        console.log(`\n🎨 [elementSheetController] Executing final AI generation with Payload:`);
        console.log(JSON.stringify(aiPayload, null, 2));

        // Execute generation task via imageTreatment with standard workflowType
        const result = await imageTreatment.execute(aiPayload);

        console.log(`\n✨ [elementSheetController] Generation task submitted successfully. ID: ${result.id}`);

        return res.json({
            ok: true,
            ...result,
            project_id,
            session_id
        });
        
    } catch (err) {
        console.error(`❌ [elementSheetController] Error generating ${workflowType} sheet:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

/**
 * POST /element-sheet/character
 */
export const createCharacterSheet = async (req, res) => {
    const systemPrompt = `You are an AI Prompt Engineer for photorealistic AI image generation. 
Your task is to convert the user's provided features, narrative descriptions, and image reference tags (e.g., <image0>) into ONE highly detailed prompt.

You MUST strictly follow and adapt this exact template structure:
"A professional character reference sheet of a [AGE]-year-old [GENDER], [ETHNICITY/NATIONALITY]. Three-panel split screen layout with minimalist white text headers on top of each section. The left panel is titled 'FRONT VIEW' showing a full-body front-facing shot. The middle panel is titled 'BACK VIEW' showing a full-body back-facing shot. The right panel is titled 'PORTRAIT DETAIL' showing a high-detail close-up face shot. The character has [HAIR STYLE & COLOR], [EYE COLOR], and [FACIAL FEATURES]. They are wearing [CLOTHING DETAILS]. The subject is isolated against a seamless, solid neutral-grey studio backdrop. Photorealistic, cinematic studio lighting, soft shadows, 8k resolution, highly detailed skin texture, raw photograph, hyper-realistic."

CRITICAL RULES:
1. Replace all bracketed [PLACEHOLDERS] with rich details extracted from the User's Features and Prompt.
2. DO NOT output the literal brackets. Make the paragraph flow fluidly.
3. If the user prompt references images via tags like <image0>, <image1>, etc., DO NOT output the literal tags. Translate them into positional natural language (e.g., replace "like <image0>" with "identical to the first provided reference image", and <image1> with "the second provided reference image"). If a tag appears alone with no text, subtly write "heavily guided by the [first/second/etc] provided reference image".
4. If a specific detail (like age or ethnicity) is missing from the user's data, invent a fitting and coherent detail to fill the template.
5. Respond with the final formatted text paragraph ONLY. No introductions, no explanations.`;

    await generateElementSheet(req, res, { systemPrompt, workflowType: "CHARACTER" });
};

/**
 * POST /element-sheet/location
 */
export const createLocationSheet = async (req, res) => {
    const systemPrompt = `You are an AI Prompt Engineer for photorealistic environment and location image generation.
Your task is to convert the user's provided prompt and structural image tags (e.g., <image0>) into ONE highly detailed prompt.

You MUST strictly follow and adapt this exact template structure:
"A professional environment concept reference sheet of a [LOCATION NAME/DESCRIPTION], located in [BIOME/SETTING] with [TIME OF DAY/WEATHER]. Three-panel split screen layout with minimalist white text headers on top of each section. The left panel is titled 'ESTABLISHING SHOT' showing a wide, panoramic view of the entire location. The middle panel is titled 'ARCHITECTURAL DETAIL' showing a closer view of the main structures or terrain features. The right panel is titled 'INTERIOR / MACRO DETAIL' showing a high-detail close-up of a specific area, texture, or interior space. The environment features [SPECIFIC DETAILS, MATERIALS, OR PROPS]. The layout is presented cleanly like an architectural visualization board. Photorealistic, cinematic lighting, volumetric fog, soft shadows, 8k resolution, highly detailed textures, raw photograph, hyper-realistic."

CRITICAL RULES:
1. Replace all bracketed [PLACEHOLDERS] with rich details extracted from the User's Prompt.
2. DO NOT output the literal brackets. Make the paragraph flow fluidly.
3. If the user prompt references images via tags like <image0>, <image1>, etc., DO NOT output the literal tags. Translate them into positional natural language (e.g., replace "mimics <image0>" with "mimics the style seen in the first provided reference image", and <image1> with "the second provided reference image"). If a tag appears alone with no text, subtly write "heavily guided by the [first/second/etc] provided reference image".
4. If a specific detail is missing, invent a fitting and visually appealing detail to fill the template.
5. Respond with the final formatted text paragraph ONLY. No introductions, no explanations.`;

    await generateElementSheet(req, res, { systemPrompt, workflowType: "LOCATION" });
};

/**
 * POST /element-sheet/product
 */
export const createProductSheet = async (req, res) => {
    const systemPrompt = `You are an AI Prompt Engineer for photorealistic product image generation.
Your task is to convert the user's provided prompt, structural image tags (e.g., <image0>), and product features into ONE highly detailed prompt.

You MUST strictly follow and adapt this exact template structure:
"A professional product design reference sheet of [PRODUCT NAME/DESCRIPTION], designed in a [MATERIAL/STYLE] finish with [COLOR PALETTE] colors. Three-panel split screen layout with minimalist white text headers on top of each section. The left panel is titled 'FRONT VIEW' showing a clean front-facing shot of the product. The middle panel is titled 'SIDE VIEW' showing a sleek profile or angled shot. The right panel is titled 'MACRO DETAIL' showing a high-detail close-up of the product's texture and materials. The product features [SPECIFIC DETAILS OR FUNCTIONS]. The subject is isolated against a seamless, solid neutral-grey studio backdrop. Photorealistic, cinematic studio lighting, soft shadows, 8k resolution, highly detailed texture, raw photograph, hyper-realistic."

CRITICAL RULES:
1. Replace all bracketed [PLACEHOLDERS] with rich details extracted from the User's Prompt.
2. DO NOT output the literal brackets. Make the paragraph flow fluidly.
3. If the user prompt references images via tags like <image0>, <image1>, etc., DO NOT output the literal tags. Translate them into positional natural language (e.g., replace "looks like <image0>" with "follows the design of the first provided reference image", and <image1> with "the second provided reference image"). If a tag appears alone with no text, subtly write "heavily guided by the [first/second/etc] provided reference image".
4. If a specific detail is missing, invent a fitting and visually appealing detail to fill the template.
5. Respond with the final formatted text paragraph ONLY. No introductions, no explanations.`;

    await generateElementSheet(req, res, { systemPrompt, workflowType: "PRODUCT" });
};
