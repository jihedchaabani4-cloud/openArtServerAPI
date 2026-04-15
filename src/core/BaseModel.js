export class BaseModel {
    constructor({
        modelName,
        provider,
        type,
        maxReferences  = 0,
        capabilities   = [],
        // ── Meta (for /api/models) ──
        displayName,
        description,
        category,
        modes,
        pricing,
        tags,
        tier,
        supportedRatios,
        maxDuration,
        minDuration,
        variants = null,
        hidden   = false,
    }) {
        this.id             = modelName; // default ID
        this.modelName      = modelName;
        this.provider       = provider;
        this.type           = type;
        this.maxReferences  = maxReferences;
        this.caps           = new Set(capabilities);
        this.editVariant    = null;
        this.hidden         = hidden;
        this.variants       = variants; // { t2v: KlingStdT2v, i2v: KlingStdI2v, etc. }
        // Meta
        this.displayName     = displayName     || modelName;
        this.description     = description     || "";
        this.category        = category        || "video";
        this.modes           = modes           || [type];
        this.pricing         = pricing         || {};
        this.tags            = tags            || [];
        this.tier            = tier            || "std";
        this.supportedRatios = supportedRatios || ["16:9", "9:16", "1:1"];
        this.maxDuration     = maxDuration     || 10;
        this.minDuration     = minDuration     || 5;
    }

    supports(cap) { return this.caps.has(cap); }

    toMeta() {
        return {
            id:              this.id,
            displayName:     this.displayName,
            description:     this.description,
            category:        this.category,
            provider:        this.provider,
            tier:            this.tier,
            modes:           this.modes,
            capabilities:    [...this.caps],
            maxReferences:   this.maxReferences,
            supportedRatios: this.supportedRatios,
            minDuration:     this.minDuration,
            maxDuration:     this.maxDuration,
            pricing:         this.pricing,
            tags:            this.tags,
            hidden:          this.hidden,
            support:         this.support || {},
        };
    }

    adapt(form)        { throw new Error(`${this.modelName} must implement adapt()`);     }
    toPayload(adapted) { throw new Error(`${this.modelName} must implement toPayload()`); }

    async generate(adapted, mode) {
        if (this.variants && this.variants[mode]) {
            return this.variants[mode].generate(adapted, mode);
        }
        throw new Error(`${this.modelName} does not support mode: ${mode}`);
    }
}
