import { getWalletService, getCreditPackage, resolvePackageCredits } from "../serviceAccessor.js";
import { getAuthUserById } from "#identity/tools";
import { createLogger } from "#shared";
import {
    buildModelsComparison,
    fetchPackagesFromDB,
    toPublicPackage,
    verifyWebhookSignature,
} from "./payments/paymentsUtils.js";

const paymentsLogger = createLogger("payments_controller");

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

        const safe = packages.map(toPublicPackage);
        const modelsComparison = buildModelsComparison(safe);

        return res.status(200).json({ ok: true, packages: safe, modelsComparison });
    } catch (err) {
        paymentsLogger.error({ event: "payments.getCreditPackages_error", err: err?.message || String(err) }, "getCreditPackages error");
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
        const userId = req.user?.id;
        const { packageId } = req.body;

        if (!packageId) {
            return res.status(400).json({ ok: false, message: "packageId is required" });
        }

        // Fetch the specific package via Billing capability
        let pkg;
        try {
            pkg = await getCreditPackage(packageId);
        } catch (error) {
            paymentsLogger.error({ event: "payments.fetch_package_error", packageId, err: error.message }, "DB error fetching package");
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

        // Get the user's email via Identity tools
        const user = await getAuthUserById(userId);

        if (!user) {
            return res.status(400).json({ ok: false, message: "Could not resolve user" });
        }

        // Build checkout URL with pre-filled email & user_id for webhook identification
        const url = new URL(pkg.checkout_url);
        if (user.email) url.searchParams.set("checkout[email]", user.email);
        url.searchParams.set("checkout[custom][user_id]", userId);
        url.searchParams.set("checkout[custom][package_id]", pkg.id);

        paymentsLogger.info({ event: "payments.checkout_url_generated", userId, packageId: pkg.id }, "Checkout URL generated");

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
        paymentsLogger.error({ event: "payments.getCheckoutUrl_error", err: err?.message || String(err) }, "getCheckoutUrl error");
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
    if (!Buffer.isBuffer(req.body)) {
        paymentsLogger.warn({ event: "payments.webhook_rejected", reason: "not_raw_buffer" }, "Webhook rejected: body is not a raw Buffer");
        return res.status(400).json({ ok: false, message: "Raw body buffer required" });
    }
    const signature = req.headers["x-signature"];

    // ① Verify signature strictly over raw Buffer
    const isValid = verifyWebhookSignature(req.body, signature);
    if (!isValid) {
        paymentsLogger.warn({ event: "payments.webhook_rejected", reason: "invalid_signature" }, "Webhook rejected: invalid signature");
        return res.status(401).json({ ok: false, message: "Invalid signature" });
    }

    let event;
    try {
        event = JSON.parse(req.body.toString("utf8"));
    } catch {
        return res.status(400).json({ ok: false, message: "Invalid JSON body" });
    }

    const eventName = event?.meta?.event_name;
    paymentsLogger.info({ event: "payments.webhook_received", eventName }, "Webhook received");

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
            paymentsLogger.info({ event: "payments.order_skipped", orderId, orderStatus }, "Order not paid, skipping");
            return res.status(200).json({ ok: true, message: "Order not paid, skipped" });
        }

        if (!userId) {
            paymentsLogger.error({ event: "payments.webhook_missing_user_id", orderId }, "Webhook missing user_id in custom_data");
            return res.status(400).json({ ok: false, message: "Missing user_id" });
        }

        // ④ Look up credits from Billing using variantId first, then packageId as fallback
        const creditsToAdd = await resolvePackageCredits({ variantId, packageId });

        if (!creditsToAdd) {
            paymentsLogger.error({ event: "payments.unknown_variant", variantId, packageId }, "Unknown product variant");
            return res.status(400).json({ ok: false, message: "Unknown product variant" });
        }

        // ⑤ Credit the wallet (idempotent via referenceId = orderId)
        const referenceId = `ls_order_${orderId}`;
        const walletService = req.walletService || getWalletService();

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

        paymentsLogger.info({ event: "payments.credits_credited", userId, creditsToAdd, orderId }, "Credits added to wallet");

        return res.status(200).json({ ok: true, message: "Credits added successfully" });
    } catch (err) {
        if (err?.code === "DUPLICATE_TRANSACTION") {
            paymentsLogger.info({ event: "payments.webhook_duplicate", err: err.message }, "Webhook replayed, already processed");
            return res.status(200).json({ ok: true, message: "Already processed" });
        }

        paymentsLogger.error({ event: "payments.webhook_error", err: err?.message || String(err) }, "Webhook processing error");
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
        const walletService = req.walletService || getWalletService();

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
        paymentsLogger.error({ event: "payments.getPurchaseHistory_error", err: err?.message || String(err) }, "getPurchaseHistory error");
        return res.status(500).json({ ok: false, message: "Internal server error" });
    }
}
