import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPublicPackage, PUBLIC_PACKAGE_FIELDS } from "#billing/api";

describe("PaymentsUtils — toPublicPackage Allowlist (Commit 1a-3)", () => {
    const legacyBlocklist = (pkg) => {
        const sensitive = new Set(["variant_id", "checkout_url"]);
        return Object.fromEntries(
            Object.entries(pkg).filter(([key]) => !sensitive.has(key))
        );
    };

    const fullPackage = {
        id: "pkg-1",
        label: "Starter Pack",
        credits: 100,
        price: 9.99,
        currency: "USD",
        yearly_price: null,
        variant_id: "var_12345",
        checkout_url: "https://lemon.squeezy/checkout/123",
        popular: false,
        is_trial: false,
        is_active: true,
        sort_order: 1,
        description: "Best for starters",
        features: ["feature 1", "feature 2"],
        plan_type: "one_time",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
    };

    it("matches legacy blocklist output for standard schema fields", () => {
        const expected = legacyBlocklist(fullPackage);
        const actual = toPublicPackage(fullPackage);

        assert.deepEqual(actual, expected);
        assert.equal(actual.variant_id, undefined);
        assert.equal(actual.checkout_url, undefined);
        assert.equal(actual.id, "pkg-1");
        assert.equal(actual.credits, 100);
    });

    it("drops unknown extra columns that legacy blocklist would have leaked", () => {
        const packageWithExtraColumns = {
            ...fullPackage,
            admin_profit_margin: 0.45,
            secret_billing_tag: "INTERNAL_ONLY",
            unexpected_database_field: "SHOULD_NOT_LEAK",
        };

        const leakedByLegacy = legacyBlocklist(packageWithExtraColumns);
        assert.equal(leakedByLegacy.admin_profit_margin, 0.45, "Legacy blocklist leaks unknown columns");

        const actual = toPublicPackage(packageWithExtraColumns);
        assert.equal(actual.admin_profit_margin, undefined, "Allowlist drops admin_profit_margin");
        assert.equal(actual.secret_billing_tag, undefined, "Allowlist drops secret_billing_tag");
        assert.equal(actual.unexpected_database_field, undefined, "Allowlist drops unexpected_database_field");
        assert.equal(actual.variant_id, undefined, "Allowlist drops variant_id");
        assert.equal(actual.checkout_url, undefined, "Allowlist drops checkout_url");
    });

    it("handles null, undefined, and non-object inputs safely", () => {
        assert.deepEqual(toPublicPackage(null), {});
        assert.deepEqual(toPublicPackage(undefined), {});
        assert.deepEqual(toPublicPackage("invalid"), {});
        assert.deepEqual(toPublicPackage(123), {});
    });

    it("PUBLIC_PACKAGE_FIELDS is frozen and contains all expected public fields", () => {
        assert.ok(Object.isFrozen(PUBLIC_PACKAGE_FIELDS));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("id"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("label"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("credits"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("price"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("sort_order"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("is_active"));
        assert.ok(!PUBLIC_PACKAGE_FIELDS.includes("variant_id"));
        assert.ok(!PUBLIC_PACKAGE_FIELDS.includes("checkout_url"));
    });
});
