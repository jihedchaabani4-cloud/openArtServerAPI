import crypto from "crypto";
import { walletService } from "../src/container.js";
import { supabase } from "../lib/supabase.js";

// ─── Signature Verification ───────────────────────────────────────────────────

/**
 * Verifies the webhook signature from Lemon Squeezy.
 * Uses HMAC-SHA256 with your LEMON_WEBHOOK_SECRET.
 */
function verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.LEMON_WEBHOOK_SECRET;

    if (!secret) {
        console.error("[Payments] LEMON_WEBHOOK_SECRET is not set!");
        return false;
    }

    if (!signature) return false;

    const hmac = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

    const hmacBuffer = Buffer.from(hmac, "hex");
    const sigBuffer = Buffer.from(signature, "hex");

    if (hmacBuffer.length !== sigBuffer.length) return false;

    return crypto.timingSafeEqual(hmacBuffer, sigBuffer);
}

// ─── Supabase Helpers ─────────────────────────────────────────────────────────

/**
 * Fetches all active credit packages from Supabase.
 * Table: credit_packages
 */
async function fetchPackagesFromDB() {
    const { data, error } = await supabase
        .from("credit_packages")
        .select("*")
        .eq("is_active", true)
        .order("credits", { ascending: true });

    if (error) {
        console.error("[Payments] Failed to fetch packages from DB:", error.message);
        return null;
    }

    return data ?? [];
}

/**
 * Builds a variantId → credits map from DB packages.
 * Used during webhook processing to know how many credits to add.
 */
async function getVariantCreditsMap() {
    const packages = await fetchPackagesFromDB();
    if (!packages) return {};

    return Object.fromEntries(
        packages.map((pkg) => [pkg.variant_id, pkg.credits])
    );
}

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /api/payments/packages
 * Returns available credit packages from Supabase (no sensitive data).
 */
export async function getCreditPackages(req, res) {
    try {
        const packages = await fetchPackagesFromDB();

        if (!packages) {
            return res.status(503).json({ ok: false, message: "Could not load packages" });
        }

        // Strip sensitive fields before sending to client
        const safe = packages.map(({ variant_id, checkout_url, ...rest }) => rest);

        return res.status(200).json({ ok: true, packages: safe });
    } catch (err) {
        console.error("[Payments] getCreditPackages error:", err);
        return res.status(500).json({ ok: false, message: "Internal server error" });
    }
}

/**
 * POST /api/payments/checkout
 * Returns the Lemon Squeezy checkout URL for the chosen package.
 * Embeds the user's ID and email in the checkout URL for webhook identification.
 *
 * Body: { packageId: "pack_100" | "pack_500" | "pack_1000" }
 */
export async function getCheckoutUrl(req, res) {
    try {
        const { packageId } = req.body;
        const userId = req.user?.id;

        if (!packageId) {
            return res.status(400).json({ ok: false, message: "packageId is required" });
        }

        // Fetch the specific package from Supabase
        const { data: pkg, error } = await supabase
            .from("credit_packages")
            .select("*")
            .eq("id", packageId)
            .eq("is_active", true)
            .maybeSingle();

        if (error) {
            console.error("[Payments] DB error fetching package:", error.message);
            return res.status(500).json({ ok: false, message: "Database error" });
        }

        if (!pkg) {
            return res.status(404).json({ ok: false, message: "Package not found or inactive" });
        }

        if (!pkg.checkout_url) {
            return res.status(503).json({
                ok: false,
                message: "Checkout URL not configured for this package",
            });
        }

        // Get the user's email from Supabase auth
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);

        if (userError || !user) {
            return res.status(400).json({ ok: false, message: "Could not resolve user" });
        }

        // Build checkout URL with pre-filled email & user_id for webhook identification
        const url = new URL(pkg.checkout_url);
        if (user.email) url.searchParams.set("checkout[email]", user.email);
        url.searchParams.set("checkout[custom][user_id]", userId);
        url.searchParams.set("checkout[custom][package_id]", pkg.id);

        console.log(`[Payments] Checkout URL generated for user ${userId}, package ${pkg.id}`);

        return res.status(200).json({
            ok: true,
            checkoutUrl: url.toString(),
            package: {
                id: pkg.id,
                credits: pkg.credits,
                price: pkg.price,
                label: pkg.label,
            },
        });
    } catch (err) {
        console.error("[Payments] getCheckoutUrl error:", err);
        return res.status(500).json({ ok: false, message: "Internal server error" });
    }
}

/**
 * POST /api/payments/webhook
 * Receives order events from Lemon Squeezy.
 * Secured by HMAC-SHA256 signature verification.
 *
 * Handles: order_created
 */
export async function handleWebhook(req, res) {
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);
    const signature = req.headers["x-signature"];

    // ① Verify signature
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
        console.warn("[Payments] Webhook rejected: invalid signature");
        return res.status(401).json({ ok: false, message: "Invalid signature" });
    }

    let event;
    try {
        event = JSON.parse(rawBody);
    } catch {
        return res.status(400).json({ ok: false, message: "Invalid JSON body" });
    }

    const eventName = event?.meta?.event_name;
    console.log(`[Payments] Webhook received: ${eventName}`);

    // ② Only handle order_created
    if (eventName !== "order_created") {
        return res.status(200).json({ ok: true, message: `Event ${eventName} ignored` });
    }

    try {
        const customData = event?.meta?.custom_data || {};
        const userId = customData.user_id;
        const packageId = customData.package_id;
        const orderId = String(event?.data?.id);
        const variantId = String(event?.data?.attributes?.first_order_item?.variant_id);
        const orderStatus = event?.data?.attributes?.status;

        // ③ Only process paid orders
        if (orderStatus !== "paid") {
            console.log(`[Payments] Order ${orderId} is not paid (status: ${orderStatus}), skipping`);
            return res.status(200).json({ ok: true, message: "Order not paid, skipped" });
        }

        if (!userId) {
            console.error("[Payments] Webhook missing user_id in custom_data");
            return res.status(400).json({ ok: false, message: "Missing user_id" });
        }

        // ④ Look up credits from DB using variantId first, then packageId as fallback
        let creditsToAdd = null;

        // Try variantId first (most reliable)
        if (variantId) {
            const { data: pkgByVariant } = await supabase
                .from("credit_packages")
                .select("credits")
                .eq("variant_id", variantId)
                .maybeSingle();

            creditsToAdd = pkgByVariant?.credits ?? null;
        }

        // Fallback: try packageId from custom_data
        if (!creditsToAdd && packageId) {
            const { data: pkgById } = await supabase
                .from("credit_packages")
                .select("credits")
                .eq("id", packageId)
                .maybeSingle();

            creditsToAdd = pkgById?.credits ?? null;
        }

        if (!creditsToAdd) {
            console.error(`[Payments] Unknown variantId: ${variantId}, packageId: ${packageId}`);
            return res.status(400).json({ ok: false, message: "Unknown product variant" });
        }

        // ⑤ Credit the wallet (idempotent via referenceId = orderId)
        const referenceId = `ls_order_${orderId}`;

        await walletService.credit({
            userId,
            amount: creditsToAdd,
            referenceId,
            metadata: {
                source: "lemon_squeezy",
                orderId,
                variantId,
                packageId: packageId || null,
            },
        });

        console.log(`[Payments] ✅ Credited ${creditsToAdd} credits to user ${userId} (order: ${orderId})`);

        return res.status(200).json({ ok: true, message: "Credits added successfully" });
    } catch (err) {
        if (err?.code === "DUPLICATE_TRANSACTION") {
            console.log(`[Payments] Webhook replayed, already processed: ${err.message}`);
            return res.status(200).json({ ok: true, message: "Already processed" });
        }

        console.error("[Payments] Webhook processing error:", err);
        return res.status(500).json({ ok: false, message: "Failed to process payment" });
    }
}

/**
 * GET /api/payments/history
 * Returns the user's purchase history (last 20 CREDIT transactions).
 */
export async function getPurchaseHistory(req, res) {
    try {
        const userId = req.user?.id;

        const transactions = await walletService.getTransactions(userId, 20, 0);

        const purchases = transactions
            .filter((tx) => tx.type === "CREDIT" && tx.metadata?.source === "lemon_squeezy")
            .map((tx) => ({
                id: tx.id,
                credits: tx.amount,
                orderId: tx.metadata?.orderId,
                packageId: tx.metadata?.packageId,
                date: tx.created_at,
                status: tx.status,
            }));

        return res.status(200).json({ ok: true, purchases });
    } catch (err) {
        console.error("[Payments] getPurchaseHistory error:", err);
        return res.status(500).json({ ok: false, message: "Internal server error" });
    }
}
