export class ModelGroup {
    constructor({
        // ── Identity ──────────────────────────────────────
        displayName,
        description,
        category    = "image",
        tier,               // "std" | "pro"
        pricing,            // { per_image: 0.04 }
        tags,               // ["fast", "multi-ref", ...]

        // ── UI config (what frontend renders) ─────────────
        support,

        // ── Model variants ────────────────────────────────
        t2i,        // text-to-image model instance (no references)
        i2i,        // image-to-image model instance (single reference)
        i2iMulti,   // image-to-image model instance (multiple references)
    }) {
        this.displayName = displayName || "";
        this.description = description || "";
        this.category    = category;
        this.tier        = tier        || "std";
        this.pricing     = pricing     || {};
        this.tags        = tags        || [];
        this.support     = support     || {};
        this.t2i         = t2i         || null;
        this.i2i         = i2i         || null;
        this.i2iMulti    = i2iMulti    || null;
    }

    // Auto-selects the correct variant based on references count
    resolve(form) {
        const refs    = form.references || [];
        const hasRefs = refs.length > 0 || !!form.image_base64;
        const isMulti = refs.length > 1;

        if (!hasRefs) {
            if (!this.t2i)
                throw new Error(`"${this.displayName}" does not support text-to-image`);
            return this.t2i;
        }

        if (isMulti) {
            const variant = this.i2iMulti || this.i2i;
            if (!variant)
                throw new Error(`"${this.displayName}" does not support multi-reference`);
            return variant;
        }

        if (!this.i2i)
            throw new Error(`"${this.displayName}" does not support image-to-image`);
        return this.i2i;
    }

    // Returns metadata for /api/models
    toMeta() {
        return {
            displayName:  this.displayName,
            description:  this.description,
            category:     this.category,
            tier:         this.tier,
            pricing:      this.pricing,
            tags:         this.tags,
            support:      this.support,
            variants: {
                t2i:      !!this.t2i,
                i2i:      !!this.i2i,
                i2iMulti: !!this.i2iMulti,
            },
        };
    }

    _mergedCaps() {
        const all = new Set();
        [this.t2i, this.i2i, this.i2iMulti]
            .filter(Boolean)
            .forEach(m => m.caps?.forEach(c => all.add(c)));
        return [...all];
    }
}
