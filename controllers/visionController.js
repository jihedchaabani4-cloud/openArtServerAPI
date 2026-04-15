import { visionService } from "../src/container.js";


/**
 * analyzeImage - POST /api/vision/analyze
 * Analyzes an image using Groq Llama 3.2 Vision
 */
export const analyzeImage = async (req, res) => {
    try {
        const { image_base64, image_url, prompt } = req.body;
        const sourceImage = image_base64 || image_url;

        if (!sourceImage) {
            return res.status(400).json({ ok: false, message: "image_base64 or image_url is required" });
        }

        const result = await visionService.analyze({
            image: sourceImage,
            prompt: prompt
        });

        res.json({
            ok: true,
            analysis: result.analysis,
            timestamp: result.timestamp
        });
    } catch (err) {
        console.error("❌ Vision analyze error:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * extractPrompt - POST /api/vision/extract-prompt
 * Extracts a prompt from an image for regeneration
 */
export const extractPrompt = async (req, res) => {
    try {
        const { image_base64, image_url } = req.body;
        const sourceImage = image_base64 || image_url;

        if (!sourceImage) {
            return res.status(400).json({ ok: false, message: "image_base64 or image_url is required" });
        }

        const prompt = await visionService.extractPrompt(sourceImage);

        res.json({
            ok: true,
            prompt: prompt
        });
    } catch (err) {
        console.error("❌ Vision extract prompt error:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};

/**
 * whatsNext - POST /api/vision/whats-next
 * Analyzes image, suggests next steps, and generates them
 */
export const whatsNext = async (req, res) => {
    return res.status(410).json({
        ok: false,
        message: "whats-next treatment is disabled",
    });
};
