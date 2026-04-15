import express from "express";
import { supabase } from "../lib/supabase.js";
import { GroqModerationService } from "../lib/groqModeration.js";
import crypto from "crypto";

const router = express.Router();

/**
 * generate - POST /api/audio/generate
 */
router.post("/generate", async (req, res) => {
    try {
        const { prompt, mood, duration, project_id, session_id } = req.body;
        const userId = 'e54d7d5f-9c49-457d-83b7-ac8484bceb80'; // Default User ID

        if (!prompt) {
            return res.status(400).json({ ok: false, message: "Prompt is required" });
        }

        console.log(`🎵 [AudioGen] Starting generation for: "${prompt}" (Mood: ${mood}, Duration: ${duration})`);

        // 1. Create a placeholder generation record
        const { data: gen, error: genError } = await supabase
            .from('generations')
            .insert({
                session_id: session_id,
                created_by: userId,
                model: "placeholder-audio-model",
                status: 'processing',
                section: "audio_generator",
                params: { 
                    prompt: prompt, 
                    original_prompt: prompt,
                    mood, 
                    duration 
                }
            })
            .select()
            .single();

        if (genError) throw genError;

        const generationId = gen.id;

        // --- TRIGGER BACKGROUND PROCESSING (Moderation + Asset Creation) ---
        _runBackgroundAudioGeneration({
            generationId,
            prompt,
            mood,
            duration,
            project_id,
            session_id,
            userId
        }).catch(err => console.error(`[AudioGen] Background Error for ${generationId}:`, err));

        return res.json({ 
            ok: true,
            data: {
                id: generationId,
                status: 'processing',
                prompt: prompt
            } 
        });

    } catch (error) {
        console.error("❌ Audio generation error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
});

/**
 * Internal background processor for audio generation
 */
async function _runBackgroundAudioGeneration({ generationId, prompt, mood, duration, project_id, session_id, userId }) {
    try {
        // Moderate and Translate Prompt (Groq)
        const modResult = await GroqModerationService.moderateAndTranslate(prompt);
        
        if (!modResult.ok) {
            console.log(`🚫 [AudioGen] REJECTED for ${generationId}: ${modResult.error}`);
            
            // Update generation to rejected status
            await supabase.from('generations').update({
                status: 'rejected',
                error_message: modResult.error
            }).eq('id', generationId);

            return;
        }

        const finalPrompt = modResult.translatedPrompt;

        // Update generation with final translated prompt
        await supabase.from('generations').update({
            params: { 
                prompt: finalPrompt, 
                original_prompt: prompt,
                mood, 
                duration 
            }
        }).eq('id', generationId);

        // 2. Create a placeholder asset record (In a real app, this would call an AI Audio Model)
        const placeholderPath = `${userId}/audio/${generationId}.mp3`;
        const { data: asset, error: assetError } = await supabase
            .from('media_assets')
            .insert({
                session_id: session_id,
                created_by: userId,
                asset_type: 'audio',
                file_url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", // Demo audio
                file_path: placeholderPath,
                mime_type: 'audio/mpeg',
                status: 'completed'
            })
            .select()
            .single();

        if (assetError) throw assetError;

        // 3. Link asset to generation and mark as completed
        await supabase
            .from('generations')
            .update({ 
                asset_id: asset.id,
                status: 'completed' 
            })
            .eq('id', generationId);

        console.log(`✅ [AudioGen] Generation finished successfully for ID: ${generationId}`);

    } catch (error) {
        if (generationId) {
            await supabase.from('generations').update({
                status: 'failed',
                error_message: error.message.substring(0, 500)
            }).eq('id', generationId);
        }
        console.error("❌ [AudioGen] Background Processing Failed:", error.message);
    }
}

export default router;
