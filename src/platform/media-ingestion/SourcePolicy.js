/**
 * SourcePolicy
 * Security rules, SSRF defense engine, and purpose-based media policies.
 */

import dns from "node:dns/promises";
import net from "node:net";

export class SourcePolicy {
    static PROFILES = {
        default: {
            maxSizeBytes: 100 * 1024 * 1024, // 100 MB
            allowedMimeTypes: [
                "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
                "video/mp4", "video/webm", "video/quicktime",
            ],
            maxImagePixels: 200 * 1000 * 1000,
            maxVideoDurationSec: 60,
            maxVideoPixels: 200 * 1000 * 1000,
        },
        avatar: {
            maxSizeBytes: 10 * 1024 * 1024, // 10 MB
            allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
            maxImagePixels: 50 * 1000 * 1000,
            maxVideoDurationSec: 0,
        },
        character_reference: {
            maxSizeBytes: 25 * 1024 * 1024, // 25 MB
            allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/avif"],
            maxImagePixels: 100 * 1000 * 1000,
            maxVideoDurationSec: 0,
        },
        video_reference: {
            maxSizeBytes: 200 * 1024 * 1024, // 200 MB
            allowedMimeTypes: ["video/mp4", "video/webm", "video/quicktime"],
            maxVideoDurationSec: 60,
            maxVideoPixels: 200 * 1000 * 1000,
        },
    };

    /**
     * Retrieves policy configuration by purpose name
     */
    static getProfile(purpose = "default") {
        return this.PROFILES[purpose] || this.PROFILES.default;
    }

    /**
     * Checks if an IP address belongs to a prohibited/internal range (SSRF defense).
     */
    static isPrivateOrRestrictedIp(ip) {
        if (!ip || !net.isIP(ip)) return true;

        // IPv6 loopback & link-local
        if (ip === "::1" || ip === "::") return true;
        if (ip.startsWith("fe80:") || ip.startsWith("fc00:") || ip.startsWith("fd00:")) return true;

        // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
        if (ip.startsWith("::ffff:")) {
            return this.isPrivateOrRestrictedIp(ip.substring(7));
        }

        if (net.isIPv4(ip)) {
            const parts = ip.split(".").map(Number);
            const [a, b] = parts;

            // 0.0.0.0/8 (Broadcast/Current network)
            if (a === 0) return true;

            // 127.0.0.0/8 (Loopback)
            if (a === 127) return true;

            // 10.0.0.0/8 (Private RFC 1918)
            if (a === 10) return true;

            // 172.16.0.0/12 (Private RFC 1918: 172.16.0.0 – 172.31.255.255)
            if (a === 172 && b >= 16 && b <= 31) return true;

            // 192.168.0.0/16 (Private RFC 1918)
            if (a === 192 && b === 168) return true;

            // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Cloud Metadata 169.254.169.254)
            if (a === 169 && b === 254) return true;

            // 100.64.0.0/10 (Carrier-Grade NAT)
            if (a === 100 && b >= 64 && b <= 127) return true;

            // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
            if (a >= 224) return true;
        }

        return false;
    }

    /**
     * Validates a target URL against SSRF attack vectors.
     * Resolves DNS to ensure no private IPs or cloud metadata endpoints are targeted.
     *
     * @param {string} urlString
     * @returns {Promise<URL>} Validated URL instance
     */
    static async validateUrl(urlString) {
        let parsed;
        try {
            parsed = new URL(urlString);
        } catch {
            throw new Error(`[SourcePolicy] Invalid URL format: "${urlString}"`);
        }

        // Scheme validation
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error(`[SourcePolicy] Prohibited URL protocol: "${parsed.protocol}". Only HTTP and HTTPS are allowed.`);
        }

        const hostname = parsed.hostname.toLowerCase();

        // Immediate hostname checks
        if (
            hostname === "localhost" ||
            hostname.endsWith(".localhost") ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
        ) {
            throw new Error(`[SourcePolicy] Access to local or internal domain "${hostname}" is forbidden (SSRF protection).`);
        }

        // Check if hostname is directly an IP literal
        if (net.isIP(hostname)) {
            if (this.isPrivateOrRestrictedIp(hostname)) {
                throw new Error(`[SourcePolicy] Access to private/internal IP address "${hostname}" is forbidden (SSRF protection).`);
            }
            return parsed;
        }

        // DNS resolution check
        try {
            const records = await dns.lookup(hostname, { all: true });
            if (!records || !records.length) {
                throw new Error(`[SourcePolicy] Could not resolve host "${hostname}".`);
            }

            for (const { address } of records) {
                if (this.isPrivateOrRestrictedIp(address)) {
                    throw new Error(
                        `[SourcePolicy] Target host "${hostname}" resolves to restricted IP "${address}" (SSRF protection).`
                    );
                }
            }
        } catch (err) {
            if (err.message?.includes("SSRF protection")) throw err;
            throw new Error(`[SourcePolicy] DNS resolution failed for "${hostname}": ${err.message}`);
        }

        return parsed;
    }

    /**
     * Validates inspected media metadata against the purpose profile limits.
     *
     * @param {Object} inspected
     * @param {Object} profile
     */
    static validateMetadata(inspected, profile) {
        if (!inspected) {
            throw new Error("[SourcePolicy] Media inspection failed: no metadata returned.");
        }

        // 1. MIME Whitelist
        if (profile.allowedMimeTypes && !profile.allowedMimeTypes.includes(inspected.detectedMime)) {
            throw new Error(
                `[SourcePolicy] File format "${inspected.detectedMime}" is not allowed for this operation. Allowed: ${profile.allowedMimeTypes.join(", ")}`
            );
        }

        // 2. Size limit
        if (inspected.sizeBytes && inspected.sizeBytes > profile.maxSizeBytes) {
            const maxMB = (profile.maxSizeBytes / (1024 * 1024)).toFixed(1);
            const actualMB = (inspected.sizeBytes / (1024 * 1024)).toFixed(1);
            throw new Error(`[SourcePolicy] File is too large (${actualMB}MB). Maximum allowed is ${maxMB}MB.`);
        }

        // 3. Image Resolution
        if (inspected.type === "image" && profile.maxImagePixels && inspected.width && inspected.height) {
            const pixels = inspected.width * inspected.height;
            if (pixels > profile.maxImagePixels) {
                const mp = (pixels / 1000000).toFixed(1);
                const maxMp = (profile.maxImagePixels / 1000000).toFixed(1);
                throw new Error(`[SourcePolicy] Image resolution is too high (${mp}MP). Maximum allowed is ${maxMp}MP.`);
            }
        }

        // 4. Video Duration & Resolution
        if (inspected.type === "video") {
            if (profile.maxVideoDurationSec && inspected.durationSec && inspected.durationSec > profile.maxVideoDurationSec) {
                throw new Error(
                    `[SourcePolicy] Video duration (${inspected.durationSec}s) exceeds maximum allowed ${profile.maxVideoDurationSec}s.`
                );
            }

            if (profile.maxVideoPixels && inspected.width && inspected.height) {
                const pixels = inspected.width * inspected.height;
                if (pixels > profile.maxVideoPixels) {
                    const mp = (pixels / 1000000).toFixed(1);
                    const maxMp = (profile.maxVideoPixels / 1000000).toFixed(1);
                    throw new Error(`[SourcePolicy] Video resolution is too high (${mp}MP). Maximum allowed is ${maxMp}MP.`);
                }
            }
        }

        return true;
    }
}

export default SourcePolicy;
