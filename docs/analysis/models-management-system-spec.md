# Models Management System — Spécification Technique Complète

**Version 1.0 — 23 Août 2026**
**Destinataire : coding agent / équipe de dev**
**Statut : document de référence, remplace tous les fragments précédents de la discussion**

---

## 0. حول هالوثيقة

هاذي الوثيقة تلخّص وتوحّد كل قرار تاخذ خلال المحادثة الكاملة على الـ Models Management System — جزء وحيد من الـ SaaS متاع generative media، مسؤول بس على تنظيم الموديلات، الأمان، السعر، والتنفيذ. أي حاجة برا هالنطاق (Wallet, Storage, Frontend, Moderation) مذكورة بس باش نبيّنو الحدود، بلا تفاصيل implementation متاعها.

هاذي النسخة تحل زوز نقاط كانو معلقين:
1. **Idempotency** كانت مبنية على `hold.id` (concept متاع Billing) — تصلحت باش تولي مفتاح عايم (`idempotencyKey`) الـ caller يبعثو، Models System ما يعرفش شنوّة معناه ولا مننين جاي.
2. **Credential Resolution** كانت تاخذ `user` مباشرة (يخالف الفصل) — تصلحت بـ dependency injection (`CredentialProvider`) باش Models System ما يحتاجش يعرف بوجود جدول Users.

---

## 1. النطاق والحدود (Scope & Non-Goals)

```
┌─────────────────────────────────────────────────────────┐
│                    YOUR SAAS (النظام الكبير)                │
│                                                             │
│  Frontend/API Gateway  ─┐                                  │
│  Wallet/Billing System  ─┤                                  │
│  Storage/Media Service  ─┼──►  GENERATION ORCHESTRATOR      │
│  Trust & Safety Service ─┤       (يستدعي، يربط، يقرر)        │
│  User/Auth/Plans        ─┘             │                    │
│                                        │ يستدعي 5 functions   │
│                          ┌─────────────▼─────────────┐      │
│                          │  MODELS MANAGEMENT SYSTEM  │      │
│                          │  (هاذي الوثيقة)              │      │
│                          └────────────────────────────┘      │
└─────────────────────────────────────────────────────────┘
```

### داخل النطاق (IN — 4 ركائز)
| ركيزة | مسؤولية |
|---|---|
| **ORGANIZE** | Registry: families, deployments, providers, collections, lifecycle, discovery |
| **SECURE** | Validation: whitelist types, strip unknown fields, SSRF guard |
| **PRICE** | حساب رقم السعر بس (pure function) |
| **RUN** | تنفيذ عند الـ provider، رجوع نتيجة خام |

### برا النطاق (OUT — Non-Goals صريحة)
| الحاجة | مسؤول عليها فعلياً |
|---|---|
| Wallet / hold / commit / release / credits | Billing System |
| تخزين دائم للـ output (upload لـ S3/CDN) | Storage/Media Service |
| Content Moderation فعلية (scan input/output) | Trust & Safety Service |
| حسابات المستخدمين، الخطط (Free/Pro)، تخزين مفاتيح BYOK | User/Auth/Billing System |
| بناء الفورم، عرض النتيجة | Frontend (عبر Discovery API) |
| queue، retries على مستوى job، notifications | Generation Orchestrator |
| اختيار provider تلقائياً عند الفشل (auto-fallback/health-routing) | **مرفوض بالتصميم — قرار بشري دايماً** |

**قاعدة الاختبار السريعة**: أي كود تكتبو جوّا `src/models/` لازم يجاوب بس على "شنوّة الموديل؟ صحيح تقنياً؟ بقداش؟ نفّذ كيفاش؟" — إذا كتبت سطر يعرف بوجود `wallet` ولا `s3` ولا `req.user`، أنت خرجت برا النطاق.

---

## 2. المبادئ الأساسية (غير قابلة للتفاوض)

1. **DATA ≠ LOGIC** — الموديلات/الـ providers/الـ pricing = JSON files (data). الـ validation/pricing/resolution = كود ثابت عام (logic). تزيد موديل = تزيد JSON، ما تلمسش logic.
2. **Management Time ≠ Runtime** — الملفات تتقرا مرة وحدة عند الـ boot، تتخزن فالذاكرة (`Registry`). كل request يخدم من الذاكرة.
3. **Deployment وحدة "servable" بس فكل لحظة** لكل (modelFamily, operation) — بلا `priority`، بلا fallback تلقائي. لو فشلت → error يرجع كيفما هو، القرار البشري (commit+deploy) هو الوحيد اللي يبدل provider.
4. **User يعرف بس Model Family** — الـ provider/deployment ما يوصلوش للـ public API، لا فالـ schema ولا فالـ practice (`stripUnknownFields` يرمي أي محاولة).
5. **Whitelist فقط، Zero Trust Input** — كل parameter عندو type محدد من قائمة مغلقة. أي حقل ماهوش معرّف يتحيد بلا error. السعر ديماً يتحسب فالسيرفر.
6. **الأمان مستويات (defense in depth)**: Rate Limit → strip → type/range → domain whitelist → server-side pricing → Adapter.

---

## 3. الكيانات الستة + دورة حياة الـ Deployment

| الكيان | يجاوب على | مثال |
|---|---|---|
| **Model Family** | "شنوّة الموديل؟" (identity بس) | `nano-banana` |
| **Provider** | "شكون هو؟ كيفاش نوصلولو؟" (بطاقة هوية، Data) | `wavespeed` |
| **Deployment** | "هذا الموديل عند هذا الـ provider" | `nano-banana.wavespeed` |
| **Operation** | "وصفة كاملة" (inputs+outputs+pricing+endpoint) | `edit`, `text_to_image` |
| **Adapter** | "نترجم؟" (canonical ↔ provider format) — واحد لكل provider، عام | `WaveSpeedAdapter` |
| **Provider Client** | "نتصل فعلياً؟" (HTTP/auth/retries) — واحد لكل provider | `WaveSpeedClient` |

### دورة حياة الـ Deployment (Lifecycle)

```
draft ──► beta ──► active ──► deprecated ──► sunset ──► disabled
(داخلي)   (canary،   (عادي)    (يخدم +      (ما يقبلش    (موقوف
          preferredDeployment            تحذير UI)    requests جداد)  فوري)
          بس)
```

| status | Servable؟ (يدخل فـ pool الـ resolver) | يظهر فـ `getCatalog()`؟ |
|---|---|---|
| `draft` | ❌ لا (غير عبر `preferredDeployment` الداخلي) | ❌ |
| `beta` | ❌ (نفس الشيء، canary يدوي بس) | ❌ (أو مخفي حسب flag) |
| `active` | ✅ | ✅ |
| `deprecated` | ✅ (يخدم عادي) | ✅ مع `deprecationNotice` |
| `sunset` | ❌ (يرفض requests جداد بـ error واضح) | ❌ |
| `disabled` | ❌ | ❌ |

**القاعدة الصلبة**: `servable = {active, deprecated}`. لازم **بالضبط واحدة** فهالمجموعة لكل (`modelFamily`, `operation`) فأي وقت — صفر = خدمة موقوفة، اثنين+ = غلطة config لازم توقف الـ CI.

---

## 4. Folder Structure النهائية

```
src/models/                              ← MODELS MANAGEMENT SYSTEM (صندوق مقفول)
│
├── index.js                             ← Public Interface (5 functions، الوحيدة اللي تتصدر)
│
├── families/{modelFamily}.json
├── deployments/{modelFamily}.{provider}.json
├── collections/{name}.json              ← عرض بس، ما تأثرش فالتنفيذ
├── shared/                              ← fragments مشتركة ($ref): resolution-standard.json...
│
├── schemas/
│   ├── v1/{family,provider,deployment,collection}.schema.json
│   └── v1.1/...                         ← نسخة مستقبلية، إضافية بس
│
├── registry/
│   ├── loader.js                        ← يقرا مرة وحدة عند boot
│   ├── validator.js                     ← JSON Schema + custom consistency checks (قسم 6)
│   └── schemaVersionMap.js
│
├── validation/
│   ├── validationService.js             ← strip + validate + defaults
│   ├── types/                           ← string, enum, integer, float, boolean, image_url, image_url[], message[]
│   └── errors.js
│
├── pricing/
│   ├── pricingFormulas.js               ← الـ 13 mode (قسم 7)
│   └── modelPricingService.js
│
├── deployment/deploymentResolver.js     ← single-servable-only، بلا priority
├── credentials/credentialResolver.js    ← pure logic + CredentialProvider injecté
│
├── execution/
│   ├── runService.js                    ← orchestration الكاملة لـ run()
│   └── idempotencyStore.js              ← interface pluggable (in-memory default)
│
├── errors/index.js                      ← Error Taxonomy كاملة (قسم 10)
├── observability/events.js              ← event emitter pluggable (قسم 11)
│
└── __tests__/{unit,contract,synthetic}/

src/providers/{wavespeed,google,fal,groq}/{provider.json, client.js, errors.js}
src/adapters/{wavespeedAdapter,googleAdapter,falAdapter,groqAdapter}.js

scripts/validate-all-configs.js          ← CI entrypoint
```

---

## 5. JSON Schemas (العقود)

### 5.1 `family.schema.json`
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "domain", "displayName"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9-]+$" },
    "domain": { "enum": ["image", "video", "text"] },
    "displayName": { "type": "string" },
    "description": { "type": "string" }
  }
}
```

### 5.2 `provider.schema.json`
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "baseUrl", "auth", "execution"],
  "properties": {
    "id": { "type": "string" },
    "baseUrl": { "type": "string", "format": "uri" },
    "auth": {
      "type": "object",
      "required": ["type", "credentialType"],
      "properties": {
        "type": { "enum": ["bearer", "apiKey", "oauth2"] },
        "credentialType": { "type": "string" }
      }
    },
    "execution": {
      "type": "object",
      "required": ["style"],
      "properties": {
        "style": { "enum": ["sync", "async"] },
        "supportsPolling": { "type": "boolean" },
        "supportsWebhook": { "type": "boolean" },
        "supportsStreaming": { "type": "boolean" }
      }
    }
  }
}
```

### 5.3 `deployment.schema.json` (القلب)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["schemaVersion", "id", "modelFamily", "provider", "status",
               "providerModelId", "providerModelVersion", "versionPolicy", "operations"],
  "properties": {
    "schemaVersion": { "type": "string" },
    "id": { "type": "string", "pattern": "^[a-z0-9.-]+\\.[a-z0-9-]+$" },
    "modelFamily": { "type": "string" },
    "provider": { "type": "string" },
    "status": { "enum": ["draft", "beta", "active", "deprecated", "sunset", "disabled"] },
    "providerModelId": { "type": "string" },
    "providerModelVersion": { "type": "string" },
    "versionPolicy": { "enum": ["pinned", "latest"] },
    "deprecationNotice": {
      "type": "object",
      "properties": { "message": { "type": "string" }, "sunsetDate": { "type": "string", "format": "date" } }
    },
    "operations": {
      "type": "object",
      "minProperties": 1,
      "additionalProperties": {
        "type": "object",
        "required": ["endpoint", "inputs", "outputs", "pricing"],
        "properties": {
          "endpoint": { "type": "string" },
          "inputs": { "type": "object" },
          "outputs": {
            "type": "object",
            "required": ["type", "fields"],
            "properties": {
              "type": { "enum": ["image", "video", "text"] },
              "fields": { "type": "object" }
            }
          },
          "allowedPassthrough": { "type": "array", "items": { "type": "string" } },
          "entitlements": { "type": "object" },
          "fieldMapping": { "type": "object" },
          "pricing": {
            "type": "object",
            "required": ["mode"],
            "properties": {
              "mode": { "enum": [
                "fixed", "quality_table", "resolution_table", "matrix",
                "matrix_plus_extra", "count_multiplier", "duration_resolution_table",
                "per_second", "per_second_with_audio_surcharge", "scale_table",
                "formula", "billable_lines", "token_based"
              ]}
            }
          }
        }
      }
    }
  }
}
```

### 5.4 `collection.schema.json`
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["id", "displayName", "members"],
  "properties": {
    "id": { "type": "string" },
    "displayName": { "type": "string" },
    "members": { "type": "array", "items": { "type": "string" }, "minItems": 2 }
  }
}
```

**Schema Versioning**: كل ملف عندو `schemaVersion`. الـ `loader.js` يستعمل `schemaVersionMap.js` باش يختار الـ schema المناسبة ويحول كل شيء لـ shape موحدة داخلياً — هذا يخليك تزيد field إجباري جديد بلا ما تكسر الملفات القديمة دفعة وحدة.

---

## 6. قواعد التماسك الإضافية (CI Consistency Checks)

JSON Schema وحدها ما تكفيش (ما تنجمش تفحص علاقات بين حقول). `registry/validator.js` لازم يفحص، بالترتيب، فـ CI + عند الـ boot:

1. **Structural** — كل ملف يحترم JSON Schema متاع `schemaVersion` متاعو.
2. **Referential integrity** — `deployment.modelFamily` موجودة فـ `families/`، `deployment.provider` موجودة فـ `providers/`.
3. **Single Servable Rule** — بالضبط واحدة `active`|`deprecated` لكل (modelFamily, operation). صفر ولا اثنين+ = فشل الـ CI.
4. **Pricing↔Inputs Consistency** — كل dimension فـ `pricing.multipliers`/`additive`/مفاتيح الـ `table` لازم موجودة فـ `inputs`، و`required: true` أو عندها `default` — وإلا خطر `NaN`.
5. **Case-sensitive exact match** — القيم فـ `inputs.values` وفـ `pricing` جداول لازم تتطابق حرفياً (`"4K"` ≠ `"4k"`).
6. **Synthetic Enum Sweep** — test تلقائي يجرب **كل تركيبة ممكنة** من enum values عبر `calculateCost()`، يتأكد النتيجة رقم صحيح (مو `NaN`/`undefined`).
7. **Output Contract Check** — `normalize()` (مع mock response) لازم يرجّع كل الحقول الـ `required` فـ `outputs.fields`.
8. **Passthrough/Canonical Collision** — مفاتيح `allowedPassthrough` ما تتقاطعش مع مفاتيح `inputs` (تفادي غموض).
9. **Schema Version Validity** — `schemaVersion` موجودة فـ `schemaVersionMap`.

```js
// scripts/validate-all-configs.js — يشغّل الـ 9 فحوصات بالترتيب، exit(1) عند أول فشل
```

---

## 7. أنماط الـ Pricing (Reference كاملة — 13 mode)

| Mode | يستعمل وقتاش | Data شكلها |
|---|---|---|
| `fixed` | سعر ثابت | `{ amount }` |
| `quality_table` | بعد واحد (quality) | `{ table: {low:4, high:12} }` |
| `resolution_table` | بعد واحد (resolution) | `{ table: {"1K":5,"4K":12} }` |
| `matrix` | بعدين مركبين، Provider يعطي جدول جاهز | `{ table: {"high:4K": 0.72} }` |
| `matrix_plus_extra` | matrix + surcharge لكل عنصر زايد (I2I) | `{ table, extraPerImage, freeImages }` |
| `count_multiplier` | طلب n نسخ فنفس الـ request | `{ baseMode, table }` |
| `duration_resolution_table` | فيديو، tiers ثابتة (5s/10s) | `{ table: {"10:1080p":30} }` |
| `per_second` | فيديو، مدة حرة (continuous) | `{ ratePerSecond }` |
| `per_second_with_audio_surcharge` | فيديو + صوت اختياري | `{ ratePerSecond, audioSurchargePerSecond }` |
| `scale_table` | Upscale | `{ table: {"2x":3,"4x":8} }` |
| `formula` | **الافتراضي** لـ 3+ أبعاد (يتفادى Combinatorial Explosion) | `{ base, multipliers, additive, overrides? }` |
| `billable_lines` | تكاليف مستقلة مركبة (base + extras شرطية) | `{ lines: [{billable, unit, cost, appliesWhen?}] }` |
| `token_based` | LLM — يُحسب من `usage` الحقيقي بعد التنفيذ، موش من `input` | `{ inputRatePer1M, outputRatePer1M }` |

**السعر ديماً string** (`"8.400000"`)، يتحول لـ `Decimal` وقت الحساب — بلا float drift.

```js
// pricing/pricingFormulas.js — دالة evaluate لكل mode، بلا if(modelId===...) في أي وحدة

const FORMULA_MAP = {
  fixed: evaluateFixed,
  quality_table: evaluateQualityTable,
  resolution_table: evaluateResolutionTable,
  matrix: evaluateMatrix,
  matrix_plus_extra: evaluateMatrixPlusExtra,
  count_multiplier: evaluateCountMultiplier,
  duration_resolution_table: evaluateDurationResolutionTable,
  per_second: evaluatePerSecond,
  per_second_with_audio_surcharge: evaluatePerSecondWithAudio,
  scale_table: evaluateScaleTable,
  formula: evaluateFormula,               // multipliers × + additive + + overrides (يفوز)
  billable_lines: evaluateBillableLines,  // sum(line.cost) لكل line اللي appliesWhen صحيح
  token_based: evaluateTokenBased,        // (usage.inputTokens/1e6)*rate + (usage.outputTokens/1e6)*rate
};

function calculateCostInternal(cleanInputOrUsage, pricingDef) {
  const formula = FORMULA_MAP[pricingDef.mode];
  if (!formula) throw new PricingConfigError(`Unknown pricing mode: "${pricingDef.mode}"`);
  return new Decimal(formula(cleanInputOrUsage, pricingDef)).toFixed(6); // string، ديماً
}
```

**قاعدة اللوپ**: كل formula تلوّع على مفاتيح `pricingDef` (multipliers/additive/lines)، أبداً على مفاتيح الـ input — نفس الـ input الكامل (quality, resolution, duration, audio, fps...) يتبعث لأي موديل، وكل واحد يسعّر بس الأبعاد المعرّفة عندو.

---

## 8. أمان الـ Input (Validation Pipeline)

### Types Whitelist (القائمة المغلقة، النسخة النهائية)
`string` · `enum` · `integer` · `float` · `boolean` · `image_url` (+ `allowedDomains`, `maxSizeMB`, https فقط) · `image_url[]` (+ `minItems`/`maxItems`) · `message[]` (LLM: `{role: enum[system,user,assistant], content: string}`)

### الـ Pipeline (بالترتيب، فـ `validationService.validateInput`)
```
1. stripUnknownFields()   → أي حقل ماهوش فـ inputSchema يطيح بلا error (totalCredits, __proto__, provider...)
2. validateField() لكل حقل معرّف → type/range/enum/SSRF domain check
3. applyDefaults()        → القيم الاختيارية الناقصة تتعمر
→ CleanInput (الوحيد اللي يوصل لـ calculateCost/run)
```

### Entitlements — توضيح الحدود بدقة
`opConfig.entitlements` (مثلاً `{ resolution: { "4K": "pro" } }`) هي **data بس**، تعيش جوّا Models System وتظهر فـ `getSchema()` (باش الـ Frontend يوري قفل/upgrade prompt) — **لكن الفحص الفعلي** ("هل هذا الـ user عندو خطة pro؟") **ما يصيرش جوّا Models System خالص**. `validateInput()` تفحص بس "هل `4K` قيمة enum صحيحة تقنياً" — القرار "مسموح لهذا الـ user" مسؤولية الـ Orchestrator/Billing، قبل ما يستدعي `run()` أصلاً.

### SSRF Guard (لـ `image_url`/`image_url[]`)
```js
function validateImageUrl(key, url, rules) {
  const parsed = new URL(url); // يرمي إذا مش URL صحيح
  if (parsed.protocol !== 'https:') throw new ValidationError(`"${key}" must use https`);
  if (!rules.allowedDomains.includes(parsed.hostname))
    throw new ValidationError(`"${key}" domain not allowed`); // ما نكشفش القائمة كاملة فالرسالة
}
```

---

## 9. الـ Public Interface (العقد الرسمي — 5 functions)

هذا **كل شيء** اللي أي خدمة أخرى (Orchestrator) تشوفو من Models System. أي حاجة أخرى داخلية، ممنوع الوصول ليها من برا.

```typescript
// ==== Discovery ====
function getCatalog(): CatalogEntry[]
interface CatalogEntry {
  modelFamily: string; displayName: string; domain: "image"|"video"|"text";
  operations: string[]; lifecycleStatus: "active"|"deprecated";
  deprecationNotice?: { message: string; sunsetDate: string };
}
// يرجّع بس servable (active/deprecated) — draft/beta/sunset/disabled ما يظهروش

function getSchema(modelFamily: string, operation: string): OperationSchema
interface OperationSchema {
  inputs: Record<string, InputFieldDef>;
  outputs: OutputSchema;
  entitlements?: Record<string, Record<string,string>>; // metadata بس، مو enforcement
  // ⛔ ما فيهاش: pricing.table, endpoint, fieldMapping, credentialType — أسرار داخلية
}

// ==== Security (يتصدر لأن الـ Orchestrator يحتاجها للـ preview/estimate) ====
function validateInput(modelFamily: string, operation: string, rawInput: object): CleanInput
// throws ValidationError | UnknownModelFamilyError | UnknownOperationError

// ==== Pricing ====
function calculateCost(
  modelFamily: string, operation: string,
  cleanInputOrUsage: object,           // input عادي (image/video) أو usage (LLM: {inputTokens,outputTokens})
  options?: { preferredDeployment?: string }  // ⚠️ داخلي/admin بس، ما يوصلش من public API
): CostResult
interface CostResult {
  amount: string; currency: "credits"; pricingMode: string;
  deploymentUsed: string; inputSnapshot: object; calculatedAt: string;
}
// re-validate داخلياً دايماً (defense in depth) — ما يوثقش إنو الـ caller خدم validateInput قبلها

// ==== Execution ====
function run(
  modelFamily: string, operation: string, cleanInput: object,
  options: {
    preferredDeployment?: string;      // داخلي/admin بس
    idempotencyKey?: string;           // ⚡ opaque، الـ caller يبعثو، Models System ما يفهمش معناه
    credentialProvider: CredentialProvider;   // ⚡ إجباري، injected
  }
): Promise<RunResult>

interface CredentialProvider {
  getCredential(credentialType: string): Promise<string | null>;
}
// Models System يقرا مفاتيحو الخاصة (platform keys) بروحو من secrets/env — هذا جزء منو.
// مفاتيح الـ user (BYOK) توصل بس عبر هالـ interface، injected من الـ Orchestrator — Models System
// ما يعرفش بوجود جدول Users، يعرف بس "اسأل هالـ function إذا فما مفتاح".

interface RunResult {
  type: "image"|"video"|"text";
  url?: string;      // ⚠️ رابط مؤقت من الـ provider — Models System ما يضمنش يبقى يخدم!
  content?: string;  // للـ text
  usage?: { inputTokens: number; outputTokens: number };
  metadata: { deploymentUsed: string; providerModelVersion: string; idempotent?: boolean };
}
```

### `credentialResolver.js` — النسخة المصححة (بلا Billing/User dependency)
```js
async function resolveCredential(deployment, provider, credentialProvider) {
  const policy = deployment.credentialPolicy?.userBYOK ?? "forbidden";

  if (policy === "required") {
    const key = await credentialProvider.getCredential(provider.auth.credentialType);
    if (!key) throw new CredentialError("BYOK required but not supplied");
    return { apiKey: key, credentialSource: "user" };
  }
  if (policy === "allowed") {
    const key = await credentialProvider.getCredential(provider.auth.credentialType);
    if (key) return { apiKey: key, credentialSource: "user" };
  }
  const platformKey = platformSecrets.get(provider.id); // Models System يدير مفاتيحو الخاصة
  if (!platformKey) throw new CredentialError(`No platform credential for "${provider.id}"`);
  return { apiKey: platformKey, credentialSource: "platform" };
}
```

### Idempotency — النسخة المصححة (بلا `hold.id`)
```js
// execution/idempotencyStore.js — interface pluggable (default: in-memory + TTL)
// ⚠️ in-memory يخدم بس لـ instance وحدة/dev — production multi-instance يحتاج Redis/DB shared

async function runWithIdempotency(idempotencyKey, executeFn) {
  if (!idempotencyKey) return executeFn();               // اختياري، لو ما تجيش نخدمو عادي
  const cached = await idempotencyStore.get(idempotencyKey);
  if (cached) return { ...cached, metadata: { ...cached.metadata, idempotent: true } };
  const result = await executeFn();
  await idempotencyStore.set(idempotencyKey, result, { ttlSeconds: 3600 });
  return result;
}
// المفتاح نفسو (كيفاش يتبنى) مسؤولية الـ Orchestrator بالكامل — Models System يستعملو كـ string عايم بس.
```

---

## 10. تصنيف الأخطاء (Error Taxonomy)

| Class | السبب | Retryable؟ | رسالة خارجية آمنة | Action |
|---|---|---|---|---|
| `ValidationError` | حقل ناقص/type غالط/enum غالط | ❌ (يحتاج input جديد) | "Invalid input: {field}" | 400 |
| `SSRFBlockedError` (فرع من فوق) | domain مامعرّفش | ❌ | "This URL host isn't allowed" (بلا كشف القائمة) | 400 |
| `UnknownModelFamilyError` / `UnknownOperationError` | modelFamily/operation مامعرّفش فالـ Registry | ❌ | "Model or operation not found" | 404 |
| `NoServableDeploymentError` | صفر deployment servable | ❌ (فوري) | "Service temporarily unavailable" | 503 + **Alert** |
| `ConfigIntegrityError` | اثنين+ deployments servable (لازم CI يمنعها، فحص دفاعي هوني زيادة) | ❌ | "Service configuration error" | 500 + **Alert فوري** |
| `CredentialError` | مفتاح ناقص/غالط | ❌ | "Authentication configuration error" | 401/403 |
| `PricingConfigError` | مفتاح ناقص فـ pricing table (خطأ config فات على الـ CI) | ❌ | "Pricing configuration error" | 500 + **Alert** |
| `ProviderRequestError` | timeout/network قبل ما يوصل provider | ✅ (بنفس idempotencyKey) | "Please try again" | 502/504 |
| `ProviderTransientError` | provider رجّع rate-limit/temporary | ✅ | "Please try again shortly" | 503 |
| `ProviderContentPolicyError` | provider رفض بسبب moderation متاعو هو | ❌ **أبداً ما تعاود** | "Content couldn't be generated" | 422 |
| `ProviderMalformedResponseError` | response ماطابقش الـ Output Contract | ❌ | "Unexpected provider response" | 500 + **Alert** (مؤشر Story upstream تبدل) |
| `OutputContractViolationError` | `normalize()` رجّع حقل ناقص (bug فـ Adapter) | ❌ | "Internal error" | 500 + **Alert** |

**قاعدة عامة**: أي رسالة توصل للـ end-user لازم generic (بلا stack trace، بلا تفاصيل provider الداخلية). التفاصيل الكاملة تتسجل فـ logs بس (قسم 11).

---

## 11. Observability

Models System يقبل `logger`/`eventEmitter` **injected** (pluggable) — ما يعرفش بوجود Datadog/أي backend محدد، غير يصرخ بأحداث structured:

| Event | Payload (بلا PII/secrets) |
|---|---|
| `models.validation.failed` | `{modelFamily, operation, reason, fieldsStripped[]}` |
| `models.deployment.resolved` | `{modelFamily, operation, deploymentId, providerModelVersion}` |
| `models.deployment.unavailable` | `{modelFamily, operation, reason}` → **triggers alert** |
| `models.pricing.calculated` | `{modelFamily, operation, deploymentId, pricingMode, amount}` |
| `models.execution.started` | `{modelFamily, operation, deploymentId, idempotencyKey?}` |
| `models.execution.succeeded` | `{..., latencyMs}` |
| `models.execution.failed` | `{..., errorType, retryable, latencyMs}` |
| `models.execution.idempotent_replay` | `{idempotencyKey, deploymentId}` |

---

## 12. Health-Check / Monitoring — الحدود بعد ما رفضنا auto-fallback

Health-check **موجود بس كـ أداة مراقبة خارجية** (script/cron منفصل، برا `src/models/`)، يستدعي `run()` العام بـ synthetic input خفيف كل ~30 دقيقة، ويسجل/ينبّه (Slack/email) عند الفشل المتكرر. 

**قاعدة صلبة**: هالسكريبت **ممنوع يبدل `status` فأي ملف config تلقائياً**. الإنسان (admin) هو الوحيد اللي يقرر ويعمل commit+deploy. Health-check = عيون بس، بلا يدين.

---

## 13. الاختبارات المطلوبة (Testing Requirements)

- **Unit**: كل mode من الـ 13 (formula → 26.6، matrix_plus_extra → 0.46، أرقام من هالوثيقة كـ fixtures)؛ كل type فالـ Validator (valid/invalid/missing/stripped/SSRF)؛ `deploymentResolver` (0→error, 1→success, 2+→ConfigIntegrityError)؛ `credentialResolver` (platform/BYOK/BYOK-required-missing).
- **Contract/CI**: `validate-all-configs.js` يخدم على configs الحقيقية، يوقف الـ PR عند أول فشل.
- **Adapter**: mocked responses (success / error-in-200-body / malformed / moderation-rejection) → تصنيف صحيح حسب قسم 10.
- **Idempotency**: نفس `idempotencyKey` مرتين → `providerClient.execute` يتنادى **مرة وحدة بس**.
- **Security**: payloads الهجوم الكامل من هالمحادثة (`__proto__`, `totalCredits`, SSRF لـ `169.254.169.254`, oversized strings) → كلها تترفض قبل ما توصل للـ Adapter.
- **Synthetic sweep** (قسم 6، نقطة 6): كل تركيبة enum → `calculateCost()` بلا `NaN`.
- **Golden path E2E**: `run()` كامل لكل deployment حقيقي، بـ HTTP fixtures مسجلة.
- **Regression rule**: إضافة deployment/model جديد ما يلزمش يبدل ولا سطر جوّا `registry/`, `validation/`, `pricing/`, `deployment/`, `credentials/`, `execution/` — بس فايلات جداد.

---

## 14. ترتيب البناء (Build Order للـ Coding Agent)

| Phase | الهدف | Definition of Done |
|---|---|---|
| 0 | Scaffolding + schemas v1 | JSON Schemas تتحقق على fixture واحدة يدوية |
| 1 | ORGANIZE (loader+validator+CI script) | boot ينجح مع 1 family/provider/deployment صحيحة، يفشل مع واحدة خايبة |
| 2 | SECURE (validationService+types+errors) | كل الـ attack scenario (قسم 13) يترفض صح |
| 3 | PRICE (13 modes) | كل mode عندو test برقم يدوي متحقق منو |
| 4 | deploymentResolver + credentialResolver | single-servable enforced، CredentialProvider mock يخدم |
| 5 | أول Adapter+Client حقيقي (WaveSpeed) | run() end-to-end على mock (success+malformed+timeout) |
| 6 | runService.js + idempotencyStore | replay test ينجح، RunResult يطابق الـ type |
| 7 | Public Interface (`index.js`) | test harness يخدم request كاملة بـ 5 functions بس |
| 8 | observability/events.js | test يجمع الأحداث المتوقعة، بلا PII/secrets |
| 9 | Provider ثاني (Google) + Model family ثانية (kling-video/fal) | **صفر تعديل** برا فايلات جداد (regression rule) |
| 10 | LLM domain (llama-3.3-70b/groq) | estimate→actual cost flow يخدم، message[] validation يخدم |
| 11 | Lifecycle states + Discovery API + Collections | getCatalog() يفلتر صح (draft/beta/sunset مخفيين) |
| 12 | Hardening: security suite + synthetic sweep + schema v1.1 test | كل شيء أخضر، config قديمة (v1) مازالت تتقرا |

---

## 15. Checklist: نزيد موديل جديد

```
□ families/{model}.json (لو family جديدة بالكامل)
□ providers/{provider}/provider.json (لو provider جديد)
□ deployments/{model}.{provider}.json — status: "draft" أول مرة
   □ operations كاملة: endpoint, inputs, outputs, pricing, fieldMapping
   □ providerModelVersion مقفولة (versionPolicy: "pinned")
□ node scripts/validate-all-configs.js  → لازم يعدي بلا تحذير
□ test: synthetic sweep على كل enum combo
□ status: "draft" → تجربة داخلية (preferredDeployment) → "active"
□ تأكد: بالضبط deployment وحدة servable لهالـ (family, operation)
□ git commit + PR + review + merge + deploy
```

---

## 16. الخلاصة

**القاعدة الذهبية**: تزيد موديل جديد = تزيد JSON files بس. صفر تعديل فـ Engines (Validator, Pricing, Resolver, Adapter interface).

**العقد الوحيد مع باقي الـ SaaS**: `getCatalog()`, `getSchema()`, `validateInput()`, `calculateCost()`, `run()` — خمسة functions، بلا ولا سطر واحد يعرف بوجود Wallet, Storage, ولا Frontend.

**الأمان**: whitelist-only + zero-trust + السعر ديماً server-side.

**الموثوقية**: deployment وحدة servable، بلا قرار آلي — الإنسان يقرر، الآلة تنبّه.
