import express from "express";
const router = express.Router();

// GET /api/health
router.get("/", (req, res) => {
    const appName = process.env.APP_NAME || "Labveil";
    res.json({ ok: true, message: `${appName} API is running 🎨` });
});

export default router;
