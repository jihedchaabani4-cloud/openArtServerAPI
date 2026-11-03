import crypto from "crypto";
import { supabase } from "../../lib/supabase.js";
import { getCatalog, calculateCost } from "../../src/models/index.js";
import { createLogger } from "../../src/infrastructure/logging/index.js";

const logger = createLogger("payments_utils");

/**
 * Explicit allowlist of safe public fields for credit packages.
 * Any new public columns added to credit_packages in Postgres must be added here explicitly.
 * Sensitive fields (variant_id, checkout_url) or future internal administrative metadata
 * are dropped by default to prevent leakage to public/client consumers.
 */
export const PUBLIC_PACKAGE_FIELDS = Object.freeze([
    "id",
    "label",
    "credits",
    "price",
    "currency",
    "yearly_price",
    "popular",
    "is_trial",
    "is_active",
    "sort_order",
    "description",
    "features",
    "plan_type",
    "created_at",
    "updated_at",
]);

const PUBLIC_PACKAGE_FIELD_SET = new Set(PUBLIC_PACKAGE_FIELDS);

export function verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.LEMON_WEBHOOK_SECRET;

    if (!secret) {
        logger.error({ event: "payments.missing_webhook_secret" }, "LEMON_WEBHOOK_SECRET is not set");
        return false;
    }

    if (!signature) {
        return false;
    }

    const hmac = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

    const hmacBuffer = Buffer.from(hmac, "hex");
    const sigBuffer = Buffer.from(signature, "hex");

    if (hmacBuffer.length !== sigBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(hmacBuffer, sigBuffer);
}

export async function fetchPackagesFromDB() {
    try {
        const { listCreditPackages } = await import("#platform/billing");
        const packages = await listCreditPackages();
        return packages ?? [];
    } catch (err) {
        logger.error({ event: "payments.fetch_packages_error", err: err?.message }, "Failed to fetch packages from Billing");
        return null;
    }
}

export function toPublicPackage(pkg = {}) {
    if (!pkg || typeof pkg !== "object") return {};
    const result = {};
    for (const field of PUBLIC_PACKAGE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(pkg, field)) {
            result[field] = pkg[field];
        }
    }
    return result;
}

function floorMediaCount(packageCredits, modelCredits) {
    const credits = Number(packageCredits) || 0;
    const cost = Number(modelCredits) || 0;

    if (cost <= 0) {
        return 0;
    }

    return Math.floor(credits / cost);
}

function buildDomainComparison({ domain, operation, defaultParams, defaultCost, unitLabel, basis, packages }) {
    const catalog = getCatalog({ domain });

    return catalog
        .map((entry) => {
            let creditsPerGeneration = defaultCost;
            try {
                const cost = calculateCost(entry.modelFamily, defaultParams);
                creditsPerGeneration = typeof cost === "number" && !isNaN(cost) ? cost : defaultCost;
            } catch {
                creditsPerGeneration = defaultCost;
            }

            return {
                key: entry.modelFamily,
                displayName: entry.displayName || entry.modelFamily,
                icon: entry.iconUrl || "",
                category: domain,
                creditsPerGeneration,
                unitLabel,
                basis,
                packageCounts: packages.map((pkg) => ({
                    packageId: pkg.id,
                    credits: pkg.credits,
                    count: floorMediaCount(pkg.credits, creditsPerGeneration),
                })),
            };
        })
        .sort((a, b) => a.creditsPerGeneration - b.creditsPerGeneration);
}

function buildImageComparison(packages) {
    return buildDomainComparison({
        domain: "image",
        operation: "text_to_image",
        defaultParams: { quality: "standard" },
        defaultCost: 10,
        unitLabel: "image",
        basis: { operation: "generated", quality: "standard" },
        packages,
    });
}

function buildVideoComparison(packages) {
    return buildDomainComparison({
        domain: "video",
        operation: "text_to_video",
        defaultParams: { durationSeconds: 5, resolution: "720p" },
        defaultCost: 20,
        unitLabel: "video",
        basis: { durationSeconds: 5, resolution: "720p" },
        packages,
    });
}

export function buildModelsComparison(packages) {
    return {
        image: buildImageComparison(packages),
        video: buildVideoComparison(packages),
    };
}
