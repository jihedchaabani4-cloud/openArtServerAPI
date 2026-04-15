import express from "express";
const router = express.Router();

// GET /api/health
router.get("/", (req, res) => {
    res.json({ ok: true, message: "Open Art API is running 🎨" });
});

export default router;
