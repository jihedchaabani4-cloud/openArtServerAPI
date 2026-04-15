/**
 * ─── CameraTask ──────────────────────────────────────────────────────────────
 *
 * Converts a user's natural-language camera description (e.g. "zoom in slowly
 * on the subject", "aerial pull-back shot") into:
 *
 *   - cameraPrompt  : cinematic text to APPEND to the main prompt
 *   - cameraControl : structured object { type, speed } for model camera_control
 *
 * Usage:
 *   const task = new CameraTask({ promptService });
 *   const result = await task.execute({ cameraText: "slow pan from left to right" });
 *   // → { cameraPrompt: "slow pan left to right, tracking shot", cameraControl: { type: "pan_left", speed: "slow" } }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

export class CameraTask {
    /**
     * @param {{ promptService: import('../../services/PromptService').PromptService }} deps
     */
    constructor({ promptService }) {
        this.promptService = promptService;
    }

    /**
     * @param {{ cameraText: string }} input
     * @returns {Promise<{ cameraPrompt: string, cameraControl: object|null }>}
     */
    async execute({ cameraText }) {
        if (!cameraText || !cameraText.trim()) {
            return { cameraPrompt: "", cameraControl: null };
        }

        console.log(`🎥 [CameraTask] Processing camera instruction: "${cameraText}"`);

        const { cameraPrompt, cameraControl } = await this.promptService.generateCameraPrompt(cameraText);

        console.log(`   ↳ camera_prompt:   "${cameraPrompt}"`);
        console.log(`   ↳ camera_control:  ${JSON.stringify(cameraControl)}`);

        return { cameraPrompt, cameraControl };
    }

    /**
     * Merges the generated camera prompt into an existing main prompt.
     * Appends cameraPrompt at the end if not already present.
     *
     * @param {string} mainPrompt
     * @param {string} cameraPrompt
     * @returns {string}
     */
    static mergeIntoPrompt(mainPrompt, cameraPrompt) {
        if (!cameraPrompt) return mainPrompt;
        const base = (mainPrompt || "").trim();
        return base ? `${base}, ${cameraPrompt}` : cameraPrompt;
    }
}
