/**
 * @owns Encapsulates database queries and retrieval for public.credit_packages.
 *
 * CreditPackageRepository
 * ─────────────────────────────────────────────────────────────────────────────
 * Private repository to the Billing system (Rule 5).
 * Encapsulates read access to the credit_packages table.
 */

import { BillingError } from "../BillingErrors.js";
import { createLogger } from "../../../infrastructure/logging/index.js";
import { supabase as defaultSupabase } from "#lib/supabase.js";

const logger = createLogger("credit-package-repo");

export class CreditPackageRepository {
    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} [supabaseClient]
     */
    constructor(supabaseClient = null) {
        this._client = supabaseClient || defaultSupabase;
    }

    get supabase() {
        return this._client || defaultSupabase;
    }

    set supabase(client) {
        this._client = client;
    }

    /**
     * List all active credit packages ordered by sort_order ascending.
     * @returns {Promise<Array<object>>}
     */
    async listActivePackages() {
        const client = this.supabase;
        if (!client) {
            throw new BillingError("[CreditPackageRepository] Supabase client is not available", 500);
        }

        const { data, error } = await client
            .from("credit_packages")
            .select("*")
            .eq("is_active", true)
            .order("sort_order", { ascending: true });

        if (error) {
            logger.error({ event: "credit_packages.list_error", err: error.message }, "Error fetching credit packages");
            throw new BillingError(`Database error fetching credit packages: ${error.message}`, 500);
        }

        return data || [];
    }

    /**
     * Find an active credit package by its primary key ID.
     * @param {string} packageId
     * @returns {Promise<object|null>}
     */
    async findActiveById(packageId) {
        if (!packageId) return null;

        const client = this.supabase;
        if (!client) {
            throw new BillingError("[CreditPackageRepository] Supabase client is not available", 500);
        }

        const { data, error } = await client
            .from("credit_packages")
            .select("*")
            .eq("id", packageId)
            .eq("is_active", true)
            .maybeSingle();

        if (error) {
            logger.error({ event: "credit_packages.find_by_id_error", packageId, err: error.message }, "Error fetching package by ID");
            throw new BillingError(`Database error fetching package: ${error.message}`, 500);
        }

        return data || null;
    }

    /**
     * Find the credit grant amount for a Lemon Squeezy variant ID.
     * @param {string|number} variantId
     * @returns {Promise<number|null>}
     */
    async findCreditsByVariantId(variantId) {
        if (!variantId) return null;

        const client = this.supabase;
        if (!client) {
            throw new BillingError("[CreditPackageRepository] Supabase client is not available", 500);
        }

        const { data, error } = await client
            .from("credit_packages")
            .select("credits")
            .eq("variant_id", String(variantId))
            .maybeSingle();

        if (error) {
            logger.error({ event: "credit_packages.find_by_variant_error", variantId, err: error.message }, "Error fetching credits by variant");
            throw new BillingError(`Database error fetching credits for variant: ${error.message}`, 500);
        }

        return data?.credits != null ? Number(data.credits) : null;
    }

    /**
     * Find the credit grant amount for a package ID.
     * @param {string} packageId
     * @returns {Promise<number|null>}
     */
    async findCreditsById(packageId) {
        if (!packageId) return null;

        const client = this.supabase;
        if (!client) {
            throw new BillingError("[CreditPackageRepository] Supabase client is not available", 500);
        }

        const { data, error } = await client
            .from("credit_packages")
            .select("credits")
            .eq("id", packageId)
            .maybeSingle();

        if (error) {
            logger.error({ event: "credit_packages.find_credits_by_id_error", packageId, err: error.message }, "Error fetching package credits by ID");
            throw new BillingError(`Database error fetching package credits: ${error.message}`, 500);
        }

        return data?.credits != null ? Number(data.credits) : null;
    }
}
