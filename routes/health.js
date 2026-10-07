import express from "express";

const router = express.Router();

/**
 * GET /health and /api/health
 * Liveness probe for process supervision.
 * Minimal response, always 200 { status: "ok" } as long as the process is running.
 */
router.get("/", (req, res) => {
    res.status(200).json({ ok: true });
});

export default router;
