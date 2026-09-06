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
