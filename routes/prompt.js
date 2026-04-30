import { Router } from "express";
import { promptService } from "../src/container.js";

const router = Router();

/**
 * POST /api/prompt/optimize
 *
 * Body: { prompt: string, mode?: "image" | "video" }
 *
 * Returns:
 *   { ok: true, optimized, originalLanguage, wasTranslated, wasEnhanced, changesSummary }
 */
router.post("/optimize", async (req, res) => {
    const { prompt, mode = "image" } = req.body;

    if (!prompt?.trim()) {
        return res.status(400).json({ ok: false, message: "prompt is required" });
    }

    try {
        const result = await promptService.optimizePrompt(prompt.trim(), { mode });
        return res.json({ ok: true, ...result });
    } catch (err) {
        console.error("[PromptRoute] optimize error:", err);
        return res.status(500).json({ ok: false, message: err.message });
    }
});

export default router;
