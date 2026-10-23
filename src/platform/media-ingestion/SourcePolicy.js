/**
 * SourcePolicy
 * Security rules, SSRF defense engine, and purpose-based media policies.
 */

import dns from "node:dns/promises";
import net from "node:net";
import { ValidationError, createPayloadTooLargeError } from "./MediaUploadErrors.js";
import {
    DEFAULT_UPLOAD_POLICY,
    ELEMENT_REFERENCE_UPLOAD_POLICY,
    ELEMENT_SHEET_UPLOAD_POLICY,
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
} from "./UploadPolicy.js";

function toLegacyProfile(policy) {
    return {
        ...policy,
        maxSizeBytes: Math.max(policy.maxImageSize || 0, policy.maxVideoSize || 0),
        imageLimit: policy.maxImageSize || 0,
        videoLimit: policy.maxVideoSize || 0,
    };
}

function validateAllowedTypeAndMime(inspected, profile) {
    if (Array.isArray(profile.allowedTypes) && profile.allowedTypes.length > 0 && !profile.allowedTypes.includes(inspected.type)) {
        throw new ValidationError(
            `[SourcePolicy] Media type "${inspected.type}" is not allowed. Allowed types: ${profile.allowedTypes.join(", ")}.`,
            { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }
        );
    }

    if (profile.allowedMimeTypes && !profile.allowedMimeTypes.includes(inspected.detectedMime)) {
        throw new ValidationError(
            `[SourcePolicy] File format "${inspected.detectedMime}" is not allowed for this operation. Allowed: ${profile.allowedMimeTypes.join(", ")}`,
            { statusCode: 415, code: "UNSUPPORTED_MEDIA_TYPE" }
        );
    }
}

function validateByteSizeCaps(inspected, profile) {
    const imageLimit = profile.maxImageSize ?? profile.imageLimit ?? 0;
    const videoLimit = profile.maxVideoSize ?? profile.videoLimit ?? 0;
    const outerLimit = profile.maxSizeBytes ?? Math.max(imageLimit, videoLimit);

    if (inspected.type === "image" && imageLimit && inspected.sizeBytes > imageLimit) {
        throw createPayloadTooLargeError(inspected.sizeBytes, imageLimit, "[SourcePolicy] Image file");
    }
    if (inspected.type === "video" && videoLimit && inspected.sizeBytes > videoLimit) {
        throw createPayloadTooLargeError(inspected.sizeBytes, videoLimit, "[SourcePolicy] Video file");
    }
    if (inspected.sizeBytes && outerLimit && inspected.sizeBytes > outerLimit) {
        throw createPayloadTooLargeError(inspected.sizeBytes, outerLimit, "[SourcePolicy] File");
    }
}

function validateDimensionAndDurationCaps(inspected, profile) {
    if (inspected.type === "image" && profile.maxImagePixels && inspected.width && inspected.height) {
        const pixels = inspected.width * inspected.height;
        if (pixels > profile.maxImagePixels) {
            const mp = (pixels / 1000000).toFixed(1);
            const maxMp = (profile.maxImagePixels / 1000000).toFixed(1);
            throw new ValidationError(`[SourcePolicy] Image resolution is too high (${mp}MP). Maximum allowed is ${maxMp}MP.`);
        }
    }

    if (inspected.type === "video") {
        if (profile.maxVideoDurationSec && inspected.durationSec && inspected.durationSec > profile.maxVideoDurationSec) {
            throw new ValidationError(
                `[SourcePolicy] Video duration (${inspected.durationSec}s) exceeds maximum allowed ${profile.maxVideoDurationSec}s.`
            );
        }
        if (profile.maxVideoPixels && inspected.width && inspected.height) {
            const pixels = inspected.width * inspected.height;
            if (pixels > profile.maxVideoPixels) {
                const mp = (pixels / 1000000).toFixed(1);
                const maxMp = (profile.maxVideoPixels / 1000000).toFixed(1);
                throw new ValidationError(`[SourcePolicy] Video resolution is too high (${mp}MP). Maximum allowed is ${maxMp}MP.`);
            }
        }
    }
}

export class SourcePolicy {
    static PROFILES = {
        default: toLegacyProfile(DEFAULT_UPLOAD_POLICY),
        avatar: {
            maxSizeBytes: 10 * 1024 * 1024, // 10 MB
            imageLimit: 10 * 1024 * 1024,
            videoLimit: 0,
            allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
            maxImagePixels: 50 * 1000 * 1000,
            maxVideoDurationSec: 0,
        },
        character_reference: toLegacyProfile(CHARACTER_DETAIL_UPLOAD_POLICY),
        character_sheet: toLegacyProfile(CHARACTER_SHEET_UPLOAD_POLICY),
        character_detail: toLegacyProfile(CHARACTER_DETAIL_UPLOAD_POLICY),
        element_reference: toLegacyProfile(ELEMENT_REFERENCE_UPLOAD_POLICY),
        element_sheet: toLegacyProfile(ELEMENT_SHEET_UPLOAD_POLICY),
        video_reference: {
            maxSizeBytes: 100 * 1024 * 1024, // 100 MB
            imageLimit: 0,
            videoLimit: 100 * 1024 * 1024,
            allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime"],
            maxVideoDurationSec: 60,
            maxVideoPixels: 200 * 1000 * 1000,
        },
    };

    /**
     * Retrieves policy configuration by purpose name.
     * @deprecated Compatibility shim during expand-contract migration; scheduled for removal in Ticket 10.
     * Import frozen UploadPolicy constants from UploadPolicy.js instead.
     */
    static getProfile(purpose = "default") {
        if (purpose && typeof purpose === "object" && Array.isArray(purpose.allowedTypes)) {
            return toLegacyProfile(purpose);
        }
        return this.PROFILES[purpose] || this.PROFILES.default;
    }

    /**
     * Checks if an IP address belongs to a prohibited/internal range (SSRF defense).
     */
    static isPrivateOrRestrictedIp(ip) {
        if (!ip || !net.isIP(ip)) return true;

        if (ip === "::1" || ip === "::") return true;
        if (ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd00:")) return true;

        if (ip.startsWith("::ffff:")) {
            return this.isPrivateOrRestrictedIp(ip.substring(7));
        }

        if (net.isIPv4(ip)) {
            const [a, b] = ip.split(".").map(Number);
            if (a === 0 || a === 127 || a === 10 || a >= 224) return true;
            if (a === 172 && b >= 16 && b <= 31) return true;
            if (a === 192 && b === 168) return true;
            if (a === 169 && b === 254) return true;
            if (a === 100 && b >= 64 && b <= 127) return true;
        }

        return false;
    }

    /**
     * Validates a target URL against SSRF attack vectors.
     * Resolves DNS to ensure no private IPs or cloud metadata endpoints are targeted.
     */
    static async validateUrl(urlString) {
        let parsed;
        try {
            parsed = new URL(urlString);
        } catch {
            throw new ValidationError(`[SourcePolicy] Invalid URL format: "${urlString}"`);
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new ValidationError(`[SourcePolicy] Prohibited URL protocol: "${parsed.protocol}". Only HTTP and HTTPS are allowed.`);
        }

        const hostname = parsed.hostname.toLowerCase();
        if (
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
        ) {
            throw new ValidationError(`[SourcePolicy] Access to local or internal domain "${hostname}" is forbidden (SSRF protection).`);
        }

        if (net.isIP(hostname)) {
            if (this.isPrivateOrRestrictedIp(hostname)) {
                throw new ValidationError(`[SourcePolicy] Access to private/internal IP address "${hostname}" is forbidden (SSRF protection).`);
            }
            return parsed;
        }

        await this._verifyResolvedDnsRecords(hostname);
        return parsed;
    }

    static async _verifyResolvedDnsRecords(hostname) {
        try {
            const records = await dns.lookup(hostname, { all: true });
            if (!records || !records.length) {
                throw new ValidationError(`[SourcePolicy] Could not resolve host "${hostname}".`);
            }

            for (const { address } of records) {
                if (this.isPrivateOrRestrictedIp(address)) {
                    throw new ValidationError(
                        `[SourcePolicy] Target host "${hostname}" resolves to restricted IP "${address}" (SSRF protection).`
                    );
                }
            }
        } catch (err) {
            if (err.message?.includes("SSRF protection")) throw err;
            throw new ValidationError(`[SourcePolicy] DNS resolution failed for "${hostname}": ${err.message}`);
        }
    }

    /**
     * Validates inspected media metadata against the policy/profile limits.
     */
    static validateMetadata(inspected, profile) {
        if (!inspected) {
            throw new ValidationError("[SourcePolicy] Media inspection failed: no metadata returned.");
        }

        validateAllowedTypeAndMime(inspected, profile);
        validateByteSizeCaps(inspected, profile);
        validateDimensionAndDurationCaps(inspected, profile);
        return true;
    }
}

export default SourcePolicy;
