import crypto from "crypto";
import { supabase } from "../../lib/supabase.js";
import { getModelMetadata } from "../../src/utils/modelUtils.js";
import {
    IMAGE_ROUTES,
    IMAGE_MODEL_TYPES,
    calculateImageCredits,
} from "../../src/image/core/modelRouter.js";
import {
    MODEL_ROUTES,
    VIDEO_MODEL_TYPES,
    calculateVideoCredits,
} from "../../src/video/core/modelRouter.js";

const SENSITIVE_PACKAGE_FIELDS = new Set(["variant_id", "checkout_url"]);

export function verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.LEMON_WEBHOOK_SECRET;

    if (!secret) {
        console.error("[Payments] LEMON_WEBHOOK_SECRET is not set!");
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
    const { data, error } = await supabase
        .from("credit_packages")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("credits", { ascending: true });

    if (error) {
        console.error("[Payments] Failed to fetch packages from DB:", error.message);
        return null;
    }

    return data ?? [];
}

export function toPublicPackage(pkg = {}) {
    return Object.fromEntries(
        Object.entries(pkg).filter(([key]) => !SENSITIVE_PACKAGE_FIELDS.has(key))
    );
}

function floorMediaCount(packageCredits, modelCredits) {
    const credits = Number(packageCredits) || 0;
    const cost = Number(modelCredits) || 0;

    if (cost <= 0) {
        return 0;
    }

    return Math.floor(credits / cost);
}

function buildImageComparison(packages) {
    return Object.entries(IMAGE_ROUTES)
        .filter(([_, route]) => route.type === IMAGE_MODEL_TYPES.GENERATED && route.open !== false && !route.hidden)
        .map(([key, route]) => {
            const group = route.group || {};
            const price = calculateImageCredits({
                modelKey: key,
                quality: "standard",
                operation: "generated",
            });
            const creditsPerGeneration = price.credits;

            return {
                key,
                displayName: group.displayName || key,
                icon: group.icon || getModelMetadata(key).iconUrl,
                category: "image",
                creditsPerGeneration,
                unitLabel: "image",
                basis: {
                    operation: "generated",
                    quality: "standard",
                },
                packageCounts: packages.map((pkg) => ({
                    packageId: pkg.id,
                    credits: pkg.credits,
                    count: floorMediaCount(pkg.credits, creditsPerGeneration),
                })),
            };
        })
        .sort((a, b) => a.creditsPerGeneration - b.creditsPerGeneration);
}

function buildVideoComparison(packages) {
    return Object.entries(MODEL_ROUTES)
        .filter(([_, route]) => route.type === VIDEO_MODEL_TYPES.GENERATED && route.open !== false && !route.hidden)
        .map(([key, route]) => {
            const info = route.info || {};
            const price = calculateVideoCredits({
                modelKey: key,
                durationSeconds: 5,
                resolution: "720p",
            });
            const creditsPerGeneration = price.credits;

            return {
                key,
                displayName: info.displayName || key,
                icon: info.icon || getModelMetadata(key).iconUrl,
                category: "video",
                creditsPerGeneration,
                unitLabel: "video",
                basis: {
                    durationSeconds: 5,
                    resolution: "720p",
                },
                packageCounts: packages.map((pkg) => ({
                    packageId: pkg.id,
                    credits: pkg.credits,
                    count: floorMediaCount(pkg.credits, creditsPerGeneration),
                })),
            };
        })
        .sort((a, b) => a.creditsPerGeneration - b.creditsPerGeneration);
}

export function buildModelsComparison(packages) {
    return {
        image: buildImageComparison(packages),
        video: buildVideoComparison(packages),
    };
}
