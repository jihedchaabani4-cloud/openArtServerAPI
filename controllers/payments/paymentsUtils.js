import crypto from "crypto";
import { supabase } from "../../lib/supabase.js";
import { getCatalog, calculateCost } from "../../src/models/index.js";

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
    const catalog = getCatalog({ domain: "image" });

    return catalog
        .map((entry) => {
            let creditsPerGeneration = 10;
            try {
                const cost = calculateCost(entry.modelFamily, "text_to_image", { quality: "standard" });
                creditsPerGeneration = parseFloat(cost.amount);
            } catch {
                creditsPerGeneration = 10;
            }

            return {
                key: entry.modelFamily,
                displayName: entry.displayName || entry.modelFamily,
                icon: entry.iconUrl || "",
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
    const catalog = getCatalog({ domain: "video" });

    return catalog
        .map((entry) => {
            let creditsPerGeneration = 20;
            try {
                const cost = calculateCost(entry.modelFamily, "text_to_video", { durationSeconds: 5, resolution: "720p" });
                creditsPerGeneration = parseFloat(cost.amount);
            } catch {
                creditsPerGeneration = 20;
            }

            return {
                key: entry.modelFamily,
                displayName: entry.displayName || entry.modelFamily,
                icon: entry.iconUrl || "",
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
