import { elementSheetTreatment } from "../src/container.js";
import { getTaskService } from "../src/services/redis-management/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Shared handler — thin wrapper around ElementSheetTreatment
// ─────────────────────────────────────────────────────────────────────────────

async function handleSheetRequest(req, res, sheetType) {
    try {
        const {
            prompt,
            features,
            project_id,
            references,
            model_name,
        } = req.body;

        console.log(`\n🚀 [elementSheetController] ${sheetType} request received`);

        if (!project_id) {
            return res.status(400).json({
                ok:      false,
                message: "project_id is required",
            });
        }

        const userId = req.user?.id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";

        const preparedTask = await elementSheetTreatment.prepare({
            sheetType,
            prompt,
            features,
            references: references || [],
            model_name,
            project_id,
            // no session_id — sheet workflows belong to the project, not a session
            userId,
        });

        // Submit to Redis queue using the dedicated element-sheet runner
        const task = await getTaskService().createTask({
            runner:   "element-sheet",
            data:     preparedTask,
            userId,
            userType: req.user?.userType || req.user?.plan || "normal",
        });

        return res.json({
            ok: true,
            batchId: preparedTask.batch?.id || null,
            configId: preparedTask.configId,
            workflows: preparedTask.workflows,
            status: "notyet",
            provider: preparedTask.model_name,
            project_id,
        });

    } catch (err) {
        console.error(`❌ [elementSheetController] Error (${sheetType}):`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
}

// ─── Route Handlers ──────────────────────────────────────────────────────────

/** POST /api/element-sheet/character */
export const createCharacterSheet = (req, res) =>
    handleSheetRequest(req, res, "CHARACTER");

/** POST /api/element-sheet/location */
export const createLocationSheet = (req, res) =>
    handleSheetRequest(req, res, "LOCATION");

/** POST /api/element-sheet/product */
export const createProductSheet = (req, res) =>
    handleSheetRequest(req, res, "PRODUCT");
