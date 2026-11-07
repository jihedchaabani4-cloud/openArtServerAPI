# OpenArt — Architecture Backend (النسخة النهائية v2)

*Modular Monolith · 10 Systems بحدود واضحة · Services حسب المسؤولية*

> **الإصدار هذا يعكس:** تحليل الـ agent (`docs/architecture-analysis.md`) وقراراتنا بعدو. الحاجات اللي مازالت مفتوحة مجمّعة في القسم 17.

## 1. القرار الأساسي

OpenArt Backend هو **Modular Monolith**: تطبيق واحد، process واحد، deployment واحد، مقسّم من الداخل إلى **Systems** (أنظمة business). كل System مسؤول على مجالو وعلى data متاعو، وما يتلمسش من برّا إلا عبر **باب واحد** (`index.js`).

**ليش مش Microservices توا؟** المشروع صغير، ما فماش فرق متعدّدة، وما فماش ضغط يستوجب scaling مستقل. Microservices تجيب تعقيدات (network، retry، idempotency، consistency، monitoring موزّع) قبل ما تجيب فوايد. نخلّيو القرار مفتوح: الحدود نظيفة من اليوم، وكان ظهر سبب حقيقي نفصل System واحد من غير ما نعاودو بناء المشروع.

**الجملة اللي تلخّص كل شي:**

> App واحدة، مقسّمة لـ Systems. كل System يملك مجالو وdata متاعو، ويعرض قائمة محدّدة من الوظائف (Tools) يستعملها الباقي. ما فماش وصول مباشر للـ internals.

**قاعدة المرحلة:** الـ refactor ينظّم الحدود برك. ما يبدّلش منطق الـ business ولا شكل الـ database.

## 2. المصطلحات

| المصطلح | المعنى |
| --- | --- |
| **System** | مجال business كامل (Billing، Media...). folder فيه باب واحد وinternals private |
| **Tool (Public API)** | وظيفة عامة يعرضها System للخارج عبر `index.js`. تكون Use Case ولا Service مصدّرة |
| **Use Case** | عملية كاملة تجمع Services وترتّب الخطوات |
| **Service** | بلوك داخلي بمسؤولية وحدة (`walletService`). private |
| **Repository** | الطبقة الوحيدة اللي تكلّم الـ database |
| **DTO** | شكل بسيط للـ data الخارجة، موش Model متاع الـ ORM |
| **Controller** | رقيق: يستقبل HTTP، يتحقق، ينادي Tool، يرجّع الجواب. يسكن في `routes/` |
| **Orchestrator** | System ينسّق بين Systems أخرى (Execution) |
| **Read Model** | طبقة قراءة برك تجمّع data من برشا Systems لشاشة واحدة. ما تملك جداول |
| **Adapter** | كود يكلّم provider خارجي (WaveSpeed، LemonSqueezy). يتعزل داخل System المالك |

**العلاقة بين Tool وUse Case:** `Tool = Use Case (ولا Service) + تصدير من index.js`. موش كل Use Case هي Tool: كان وظيفة داخلية ما يحتاجها حتى System آخر، ما تتصدّرش.

## 3. الوضع الحالي والمستهدف

الـ backend الحالي هو **Layered Monolith هجين**: الكود مقسّم لطبقات، لكن ما فماش حدود بين المجالات. أهم أعراضو (من تحليل الـ agent):

- `db` bag في `container.js` يمرّر 9 Repositories لـ 14 خدمة، فأي خدمة تنجّم تكتب في أي جدول.
- جدول `workflow` يكتب فيه 8 جهات، وجدول `media` 9 جهات.
- Controllers فيهم business logic وSupabase مباشرة (`authController`، `paymentsController`).
- دوائر استيراد (حلقة 15 ملف عبر `container.js`، وSetters ثنائية الاتجاه).

### الـ folders الحالية وين تمشي

| Folder الحالي | شنوّة فيه فعلاً | وين يمشي |
| --- | --- | --- |
| `controllers/` | HTTP handlers (بعضهم فيه business logic) | `src/routes/` رقاق. المنطق يمشي لـ Services داخل الـ Systems |
| `src/platform/storage/` | التخزين الفيزيائي | `systems/storage/` |
| `src/platform/media/` و`media-ingestion/` | دورة حياة الـ media والرفع | `systems/media/` |
| `src/platform/billing/` | Wallet، FailedOps، Pricing | Wallet وFailedOps لـ `systems/billing/`، وPricing لـ `systems/models/` |
| `src/platform/workflow/` | كروت الـ workflow وربط الوسائط | `systems/workflow-container/` |
| `src/platform/security/ownership.js` | فحص الملكية على 6 جداول | يتفتّت: كل System ياخو `assert*Owned` متاعو، والملف يتحذف |
| `src/domain/project/` و`folder/` | المشاريع والمجلدات | `systems/workspace/` |
| `src/domain/asset/` و`trash/` | رفع الأصول وسلة المهملات | `systems/workflow-container/` |
| `src/domain/character/` | الشخصيات | `systems/character/` |
| `src/domain/element/` | العناصر المرجعية | `systems/element/` |
| `src/domain/generation/` | طلب التوليد + قراءة المكتبة | الطلب لـ `systems/execution/`، والقراءة لـ `src/read-models/` |
| `src/domain/project/ProjectReadService.js` | تجميع بيانات الكانفاس | `src/read-models/` |
| `src/db/` | الـ Repositories | كل Repository يمشي لـ `repositories/` متاع الـ System اللي يملك الجدول |
| `src/v2/` | محرك الـ DAG | `systems/execution/engine/` |
| `src/services/useCaseService.js` | orchestration التوليد | `systems/execution/` |
| `src/services/jobQueueService.js` | BullMQ (تقني) | `shared/queue/` |

**ملاحظة:** `platform` و`domain` ما يعكسوش الفرق بين infra وbusiness. `platform` فيها business حقيقي (Billing، Workflow، Media)، ولذلك نفكّو الـ folderين كامل. الحاجات التقنية الصافية (logger، db client، queue) تمشي لـ `shared/`.

## 4. هيكل المشروع

```
src/
├── systems/
│   ├── identity/
│   ├── billing/
│   ├── storage/
│   ├── media/
│   ├── models/
│   ├── workspace/
│   ├── workflow-container/
│   ├── character/
│   ├── element/
│   └── execution/
│
├── read-models/       ← تجميع data للشاشات (يقرا عبر Tools برك)
├── shared/            ← config، logger، db client، queue، utils تقنية
├── routes/            ← Controllers رقاق (HTTP برك)
├── middlewares/       ← requireAuth، validation، error handler
├── container.js       ← يركّب الـ Systems عبر index.js برك
└── app.js
```

### مسؤولية كل System

| System | المسؤولية | الجداول اللي يملكها |
| --- | --- | --- |
| **Identity** | Auth، Sessions، Profiles، دور الأدمن | `profiles` (+ Supabase `auth.users`) |
| **Billing** | Wallet، holds ذرية، باقات الشحن، webhook الدفع، المطابقة | `wallets`، `transactions`، `usage_events`، `failed_wallet_operations`، `credit_packages` + 6 RPCs |
| **Storage** | التخزين الفيزيائي وSigned URLs | ما عندو جداول (bucket `generated_images`) |
| **Media** | `media` كـ entity، الرفع والمعالجة (Sharp)، الـ placeholders | `media` |
| **Models** | Catalog الـ models (21 Model Manifests و22 ملف bindings؛ منها 6 systemOnly و15 للـ media)، validation، التسعير، تشغيل الـ providers | 21 Manifests + 22 bindings + `pricing_rules` (Tech Debt) + `provider_credentials` |
| **Workspace** | المشاريع والمجلدات (عمق أقصى 3، حد أقصى 50 لكل مشروع) | `project`، `folders` |
| **WorkflowContainer** | كروت الكانفاس، ربط الوسائط، الكفر، سلة المهملات | `workflow`، `workflow_media`، `trash`، `generation_config*` + 5 RPCs |
| **Character** | الشخصيات وصورها ووصف الـ Art Director | `characters` |
| **Element** | العناصر المرجعية، سعة الصور، الـ DNA البصري، ترجمة `@Element` | `element` |
| **Execution** | الـ Orchestrator: طلب التوليد، محرك الـ DAG، الطوابير، حجز الرصيد وتسويتو | `v2_workflow_runs`، `v2_workflow_run_nodes` + طابور `v2-workflow-jobs` |

**التسعير:** `pricingEngine` (المبني على الـ Manifests) هو المسار الفعلي للتوليد. `pricing_rules` وPricingService يتحطّو في Models ويتوسّمو **Tech Debt**: قرار حذفهم أو تفعيلهم مؤجّل (قرار product). Models تصدّر Tool واحدة للسعر: `calculateCost`.

## 5. هيكل System كامل

```
billing/
├── index.js                  ← الباب الوحيد (Tools)
│
├── use-cases/                ← عمليات تجمع Services (تتزاد كي تلزم)
│
├── services/                 ← بلوكات private
│   ├── wallet/
│   ├── payments/
│   └── failedOps/
│
├── repositories/             ← database برك
│
├── dto/                      ← الشكل الخارج
├── errors.js                 ← أخطاء مسمّاة
└── config.js                 ← إعدادات متاع System
```

### حجم الـ System يحدّد الهيكل

| حجم System | الهيكل |
| --- | --- |
| صغير (Storage، Identity) | `index.js` + `services/` + `repositories/` |
| متوسّط (Media، Models، Workspace، Character، Element) | زيد `dto/` وerrors.js |
| كبير (Billing، WorkflowContainer، Execution) | الهيكل الكامل مع `use-cases/` |

**القاعدة:** زيد `use-cases/` كي تلقى `index.js` يبدا يكبر، ولا الـ function العامة تحتاج تنسّق بين برشا Services ولا تفتح transaction.

Service صغير = ملف واحد. يتحوّل لـ folder كي يكبر ولا يحتاج ملف `Rules`.

## 6. دور كل ملف

| الملف | شنوّة يعمل | شنوّة ما يعملش |
| --- | --- | --- |
| `index.js` (System) | يصدّر الـ Tools | ما فيه منطق |
| `use-cases/*` | يرتّب الخطوات بين Services، يفتح transaction، ينادي Systems أخرى | ما يكتبش SQL |
| `services/*` | منطق business بمسؤولية وحدة، وكان يلزم Adapter لـ provider خارجي | ما يعرفش HTTP، ما ينادي use-case |
| `*Rules.js` | قواعد صافية | ما يقراش database |
| `repositories/*` | يقرا ويكتب في جداول System (وينادي الـ RPCs متاعو) | ما فيه قواعد business |
| `dto/*` | يحوّل Model لشكل بسيط | ما فيه منطق |
| `errors.js` | أخطاء مسمّاة (`INSUFFICIENT_CREDITS`) | ما يعرفش HTTP status |
| `config.js` | إعدادات System من env | ما فيه منطق |
| Controller (`routes/`) | يستقبل، يتحقق، ينادي Tool، يترجم الأخطاء لـ HTTP status | ما فيه منطق business |

## 7. اتجاه الاستدعاء

### داخل System

```
index.js  →  use-case  →  service  →  repository
```

الاتجاه واحد برك. Service ما تنادي Use Case، وRepository ما تنادي Service.

### بين Systems (حسب تحليل الـ agent)

```
Execution          ──▶ Models، Billing، Media، Workspace، WorkflowContainer، Character، Element، Storage
Character، Element ──▶ Media، Models، Workspace، WorkflowContainer
WorkflowContainer  ──▶ Media، Storage، Workspace
Media              ──▶ Storage
Identity           ──▶ Billing  (⚠ مفتوح، انظر القسم 17)
Billing، Models، Storage، Workspace ──▶ (ما يكلّمو حتى System)
```

**الـ Systems الصغار (Identity، Storage، Models) ما تنادي الكبار.** سهم `Identity ──▶ Billing` يخالف هذي القاعدة، وسهم `Billing ──▶ Models` اللي كان في التقرير ما عندو دليل في الكود (اللي ينادي `calculateCost` هو Execution وroutes)، فتشطب.

### مسار الطلب كامل

```
HTTP Request
   ↓
Controller (routes/)           ← validation + auth
   ↓
Tool (index.js)                ← باب System
   ↓
Use Case                       ← ترتيب الخطوات
   ├──▶ Service ──▶ Repository ──▶ DB
   └──▶ Tool متاع System آخر
   ↓
DTO                            ← جواب بسيط
```

### مسار القراءة المركّبة

```
GET /project-data/:id
   ↓
Controller ──▶ read-models/ProjectReadService
                  ├──▶ workspace.getProject
                  ├──▶ workflowContainer.listContainersByProject
                  ├──▶ media.listMediaByProject
                  ├──▶ character.listCharactersByProject
                  └──▶ element.listElementsByProject
                  (بالتوازي بـ Promise.all، والتجميع في الذاكرة)
```

هذا كيف يخدم الكود توّا (Scatter-Gather في الذاكرة). نقيسو الـ latency قبل وبعد النقل على `/library` و`/project-data/:id`.

## 8. القواعد (Rules)

### أ) قواعد الحدود

1. من برّا System، تستورد من `index.js` برك. ممنوع Deep Imports.
2. كل System يقرا ويكتب في جداولو برك. كان تحتاج data متاع System آخر، تنادي Tool متاعو.
3. ما فماش Joins بين Systems في كود Node.js. `userId` وغيرو يتخزّنو كـ ID عادي. **الـ Foreign Keys الموجودة في الـ DB نخلّيوها مؤقتاً** (11 FK عابر بين Systems، موثّقين في تقرير الـ agent)، ونحوّلوها بعد ما الأنظمة تستقرّ. ما نبدّلوش الـ schema في المرحلة هذي.
4. ما تتمرّرش Models متاع الـ ORM بين Systems. نرجّعو DTOs.
5. ما فماش circular dependency بين Systems. كان صارت، ادمج الـ Systems ولا اطلّع الحاجة المشتركة لـ System ثالث ولا اعكس الاتجاه.
6. `shared/` فيه حاجات تقنية برك. ما فيه business logic.
7. الـ providers الخارجية (WaveSpeed، LemonSqueezy، Storage) تتعزل في Adapter داخل System المالك.
8. فحص الملكية يولّي Tool متاع كل System (`assertProjectOwned`، `assertContainerOwned`...). ما يرجعش فما ملف مركزي يستعلم على برشا جداول.
9. الـ `read-models/` تقرا عبر Tools برك، وما تكتبش وما تستعمل SQL مباشر.

### ب) قواعد الـ RPCs (PL/pgSQL)

10. الـ 6 RPCs متاع Billing ما يتبدّلوش (لا توقيع لا منطق).
11. الـ RPCs اللي تلمس جداول من Systems مختلفة (`attach_workflow_reference_media`، `unlink_workflow_media_and_reap_orphan`، `create_workflow_with_placeholder_media`) تبقى في الـ DB كيما هي، وتتعتبر **مملوكة لـ WorkflowContainer**. السبب: القفل الذري ومنع الـ race conditions.
12. الـ Repository هو اللي ينادي الـ RPC، موش الـ Service.

### ج) قواعد الطبقات

13. Controller رقيق: يستقبل، يتحقق من الشكل، ينادي Tool، يترجم الأخطاء.
14. Use Case ما يعرفش `req` ولا `res`.
15. Service مسؤولية وحدة، وما يعرفش HTTP.
16. Service ما يكتبش SQL مباشرة، يستعمل Repository.
17. Service ما تنادي Use Case، وما فماش دايرة بين Services.
18. Repository ما فيه قواعد business.
19. الـ transactions تتفتح في الـ Use Case وتتمرّر للـ Repositories.

### د) قواعد الـ Tools (الواجهة)

20. ما نصدّرو من `index.js` إلا اللي يحتاجو System آخر فعلاً.
21. Tool تتسمّى باسم business، موش اسم تقني.
22. الـ Tool ترجّع DTO بسيط.
23. Tool ممكن تكون Service مصدّرة مباشرة (كان العملية خطوة وحدة)، وكي تتعقّد نحوّلوها لـ Use Case من غير ما نبدّلو اسمها.

### هـ) قواعد الأخطاء والعمليات الحسّاسة

24. الأخطاء مسمّاة ومعرّفة في `errors.js` متاع كل System.
25. الـ System ما يعرفش HTTP status. الـ Controller يترجم `INSUFFICIENT_CREDITS` لـ 402 مثلاً.
26. العمليات المالية (`reserveCredits`، `creditWallet`...) لازم تاخو مفتاح idempotency.
27. أي input جاي من برّا يتفحص في الـ Controller قبل ما يوصل للـ Tool.

### و) قواعد خاصة بالمرحلة

28. **Workflow Freeze:** السلوك المجمّد لجدول `workflow` (حسب `BUSINESS_SYSTEMS_RULES.md`) ننقلوه بلا ما نبدّلوه. نقل WorkflowContainer يتطلّب موافقة صريحة.
29. أي تغيير سلوك (حتى كان إصلاح bug) يتعمل في commit مستقل قبل النقل، وما يتخلطش معاه.

### ز) قواعد التسمية

| النوع | القاعدة | مثال |
| --- | --- | --- |
| System (folder) | اسم الـ domain بالمفرد، kebab-case | `billing`، `workflow-container` |
| Use Case | فعل + مفعول | `reserveCredits`، `requestMediaGeneration` |
| Service | اسم + `Service` | `WalletService` |
| Repository | اسم الجدول + `Repository` | `ProjectRepository` |
| DTO | `toXxxDto` | `toBalanceDto` |
| Alias | `#` + اسم System | `#billing`، `#workflow-container` |

## 9. الـ index.js (الباب)

```js
// billing/index.js
import { reserveCredits } from "./use-cases/reserveCredits.js";
import { walletService } from "./services/wallet/index.js";

export const billing = {
  reserveCredits,                       // Use Case = Tool
  getBalance: walletService.getBalance, // Service مباشرة = Tool
};

export * from "./errors.js";
```

الاستعمال من System آخر:

```js
import { billing } from "#billing";

await billing.reserveCredits({ userId, amount, idempotencyKey });
```

## 10. مثال: reserveCredits

> الأسماء توضيحية. النقطة المهمّة: **الذرية في Billing تجي من الـ RPC في الـ DB** (`hold_credits`)، موش من قراءة الرصيد وكتابتو في Node.js، لأنّ هذا النمط يفتح race conditions.

**Repository (ينادي الـ RPC):**

```js
// billing/repositories/walletRepository.js
export const walletRepository = {
  hold: (params) => /* rpc("hold_credits", params) */,
  commit: (params) => /* rpc("commit_transaction", params) */,
  rollback: (params) => /* rpc("rollback_transaction", params) */,
};
```

**Service:**

```js
// billing/services/wallet/walletService.js
import { walletRepository } from "../../repositories/walletRepository.js";

export const walletService = {
  hold: (userId, amount, idempotencyKey) =>
    walletRepository.hold({ userId, amount, idempotencyKey }),
  // commit / rollback / credit بنفس الشكل
};
```

**Use Case (كان يلزم ينسّق أكثر من خطوة):**

```js
// billing/use-cases/reserveCredits.js
export async function reserveCredits({ userId, amount, idempotencyKey }) {
  return walletService.hold(userId, amount, idempotencyKey);
}
```

**Controller:**

```js
// routes/walletRoutes.js
router.get("/balance", async (req, res, next) => {
  try {
    res.json(await billing.getBalance(req.user.id));
  } catch (e) { next(e); }
});
```

## 11. الحماية (باش الحدود تتحترم)

**أ) Alias في `package.json`:**

```json
{
  "imports": {
    "#identity": "./src/systems/identity/index.js",
    "#billing": "./src/systems/billing/index.js",
    "#storage": "./src/systems/storage/index.js",
    "#media": "./src/systems/media/index.js",
    "#models": "./src/systems/models/index.js",
    "#workspace": "./src/systems/workspace/index.js",
    "#workflow-container": "./src/systems/workflow-container/index.js",
    "#character": "./src/systems/character/index.js",
    "#element": "./src/systems/element/index.js",
    "#execution": "./src/systems/execution/index.js"
  }
}
```

**ب) `arch-check.cjs` (قاعدة R10) لمنع Deep Imports عبر الـ Ratchet:**

بدل ESLint `no-restricted-imports`، نعتمدو قاعدة **`R10`** الميكانيكية في `scripts/arch-check.cjs` مع آلية Ratchet صارمة تفحص في كل commit عبر `npm run gate`:
- **المنع الصارم:** من خارج `src/systems/<name>/`، ممنوع استيراد أي ملف داخلي غير `src/systems/<name>/index.js` أو الـ alias `#<name>`.
- **الشمولية:** تفحص جميع أشكال الاستيراد: `require()`, `import`, `export ... from`, و`import()` الديناميكي، سواء بالمسارات النسبية (`../systems/...`) أو الـ aliases (`#name/...`).
- **استثناءات مؤقتة مبرّرة:** الاستثناءات الانتقالية تُدار عبر ملف مستقل `scripts/arch-exceptions.json` يربط كل استثناء بـ ADR صريح ومرحلة الإلغاء (مثل استثناء Facade-First لـ WorkflowContainer في ADR-0020 حتى المرحلة 7).

**ج) `npm run gate` إلزامي قبل كل commit:** يمنع أي خرق جديد، والـ baseline يتناقص فقط ولا يرتفع أبداً.

**د) اختياري لاحقاً:** `dependency-cruiser` في الـ CI.

## 12. وقتاش نزيد كل حاجة

| الحاجة | وقتاش |
| --- | --- |
| `use-cases/` | كي عملية تجمع 2 Services ولا أكثر، ولا فيها transaction |
| Service كـ folder | كي يكبر ولا يحتاج `Rules` |
| `dto/` | كي تحب تحمي الشكل الخارج |
| Adapter لـ provider خارجي | كي نعزلو الـ provider داخل System المالك |
| ESLint rule | من البداية |
| `dependency-cruiser` | كي يكبر الفريق ولا المشروع |
| Events | كي تحب تخبّر من غير ما تستنّى جواب |
| Registry / Tools بـ schema / MCP | كي تحب تعرض Tools للـ agents |
| Microservice | كي يظهر سبب حقيقي |

## 13. وقتاش نفصل System لـ Microservice

نفصل **كان** تحصل واحدة من هاذم:

- ضغط كبير على جزء معيّن (مثلاً generation workers) يخلّيك تحتاج scaling وحدو.
- فريق ثاني يخدم على System ويحتاج deployment مستقل.
- System يحتاج تقنية مختلفة (مثلاً Python لـ ML).
- عطب في System يوقّف الباقي وتحتاج عزلة.

أول مرشّح عادة هو **Execution**. وكي نفصلو: الـ Services والـ Repositories تتنقل كيف ما هي، `index.js` في الـ Backend الرئيسي يولّي HTTP client، والـ callers ما يتبدّلوش.

## 14. Checklists

### إضافة System جديد

1. اعمل folder `systems/<name>/` مع `index.js`.
2. حدّد مسؤوليتو في جملة وحدة، والجداول اللي يملكها.
3. زيد alias `#name` في `package.json`.
4. صدّر من `index.js` الـ Tools اللي الآخرين يحتاجوها برك.
5. حدّد شكون يكلّم ويتكلّم معاه، وتأكد ما فماش دايرة.

### إضافة Tool جديدة

1. واحد من برّا System يحتاجها فعلاً؟ كان لا، ما تصدّرهاش.
2. خطوة وحدة؟ صدّر Service مباشرة. أكثر؟ اكتب Use Case.
3. حدّد الـ input والـ output (DTO).
4. كان عملية مالية: زيد مفتاح idempotency.
5. صدّرها من `index.js`.

### إضافة Service جديدة

1. مسؤولية جديدة مستقلة؟ كان لا، زيدها في Service موجودة.
2. ما تعرفش HTTP، وما تكتبش SQL.
3. القواعد الصافية في `Rules.js`.
4. ما تنادي Use Case ولا تعمل دايرة مع Service أخرى.

## 15. أخطاء لازم نتجنّبوها

- **God Service:** Service واحد فيه كل شي. علامة: تجاوز 200 سطر، ولا يستعمل أكثر من 3 repositories من مجالات مختلفة.
- **Deep Imports:** استيراد ملف داخلي متاع System آخر.
- **مشاركة الجداول:** System يقرا ولا يكتب مباشرة في جدول متاع System آخر (مثل ما صاير توّا في `workflow` و`media`).
- **`db` bag مشترك:** تمرير كل الـ Repositories لكل الخدمات.
- **تسريب Models متاع الـ ORM** بين Systems.
- **منطق في Controller.**
- **Service تعرف HTTP:** `req` و`res` داخل Service.
- **Circular dependencies** بين Systems ولا بين Services.
- **Over-engineering:** نبنيو Registry وEvents وMicroservices قبل ما نحتاجوهم.
- **تبديل منطق Billing ولا الـ database** باش نطبّق Architecture. ننظّمو الحدود أولاً، والتحسينات بعدها وبشكل منفصل.
- **كتابة الـ transactions المالية في Node.js** بقراءة وكتابة الرصيد. نستعملو الـ RPCs الذرية.

## 16. ترتيب التطبيق على المشروع

كل مرحلة: `git mv` باش التاريخ يبقى، خطوات صغيرة، والـ tests تمرّ قبل ما نكملو. التراجع بـ `git revert` متاع الـ commit.

| المرحلة | النطاق | الحجم | ملاحظات |
| --- | --- | --- | --- |
| **0** | نظافة: حذف الملفات الميتة المؤكدة، تفعيل قواعد `arch-check` | صغير | تصحيح العدد قبل الحذف (التقرير يقول 10 ويعدّد 7) |
| **0ب** | إصلاحات سلوك، كل واحدة commit مستقل: توحيد الـ Reaper timer (`index.js:249`)، مفتاح Redis (`reconcile:latest` مقابل `reconciliation:latest`) | صغير | قبل أي نقل |
| **1 (Pilot)** | **Workspace** (`project`، `folders`) | صغير | السبب: جدولين نقيين، بعيد عن المال، ما يخضعش لـ Workflow Freeze، و19 اختبار |
| **2** | Identity | صغير-متوسط | |
| **3** | Billing | متوسط | ممنوع تبديل أي RPC |
| **4** | Models (مع Pricing كـ Tech Debt) | صغير | فك الدايرة `index.js ↔ catalogPresentation.js` |
| **5** | Media | متوسط | منع `db.media` من برّا |
| **6** | Character وElement | متوسط | ⚠ يحتاجو `createContainer` من WorkflowContainer (انظر القسم 17) |
| **7** | WorkflowContainer | كبير | يتطلّب موافقة صريحة (Workflow Freeze) |
| **8** | Execution وread-models وتنظيف `container.js` | كبير | إلغاء `export const db` نهائياً |

**شنوّة نأجّلو:** Events، Registry، Microservices، تغيير الـ FKs، حذف `pricing_rules`.

## 17. نقاط مفتوحة

| # | النقطة | الحالة |
| --- | --- | --- |
| 1 | `Identity ──▶ Billing` (إنشاء wallet عند التسجيل) يخالف قاعدة "الصغار ما ينادوش الكبار". الحلول: Billing يخلق الـ wallet عند أول استعمال، أو الـ Controller ينادي Tool متاع Billing بعد `signUp` | يحتاج قرار |
| 2 | ترتيب المراحل 6 و7: Character وElement يحتاجو `createContainer` قبل ما WorkflowContainer يتعمل. الحلول: نبدّلو الترتيب، أو tool مؤقتة | يحتاج قرار |
| 3 | `src/workers/` و`src/queue/walletQueue.js` و`index.js` في الـ root: الـ Mapping ما حدّد وين يمشيو | سؤال للـ agent |
| 4 | الـ `routes/` الموجودة في الـ root (مثلاً `modelsRoute.js`) وكيفاش تتدمج مع `src/routes/` | سؤال للـ agent |
| 5 | دايرة `FolderService ↔ WorkflowService` (حذف مجلد يخلّي الكروت): use case على مستوى التطبيق، ولا الاعتماد على `ON DELETE SET NULL` | يحتاج قرار في المرحلة 1 |
| 6 | الدمج المستقبلي لـ Character وElement إذا تشاركو نفس الـ logic | مؤجّل |
| 7 | مصير `pricing_rules` (حذف ولا تفعيل) | قرار product مؤجّل |

### قرارات تمّ حسمها

- **RPCs العابرة للأنظمة:** تبقى في الـ DB، مملوكة لـ WorkflowContainer.
- **الـ Reaper:** نوحّدوه، في commit مستقل قبل النقل.
- **`ownership.js`:** نفتّوه System بعد System.
- **Read Models:** تجميع عبر Tools في `src/read-models/`، مع قياس الـ latency.
- **التسعير:** كل شي في Models، `calculateCost` Tool وحيدة، و`pricing_rules` موسوم Tech Debt.
- **الهيكل:** `src/systems/<name>/index.js` مع alias `#<name>`، والنقل بـ `git mv` System بعد System.
