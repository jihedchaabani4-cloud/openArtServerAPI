# تقرير التحليل المعماري الشامل للـ Backend (`apiOpenArt`)
## الانتقال نحو Modular Monolith محكم الحدود (النسخة المحدثة v2)

> **تاريخ التحديث:** 2026-11-04  
> **الدور:** Senior Backend Architect  
> **حالة الكود:** تحليل وقراءة حصرية (Read-Only Analysis) بدون أي تعديل أو نقل لأي ملف كود.  
> **المرجع المعماري المعتمد:** `docs/architecture/BACKEND_ARCHITECTURE.md` (النسخة v2).

---

## 1. الملخّص التنفيذي (Executive Summary)

1. الـ Backend الحالي لـ OpenArt (`apiOpenArt/`) هو **Layered Monolith هجين** يمر بمرحلة انتقالية بين ثلاثة أجيال معمارية متعاقبة (V1 Workflows وV2 DAG Engine ومحاولات استخراج الخدمات).
2. التحليل غطّى **236 ملف كود إنتاجي**، **132 ملف اختبار**، و**24 جدولاً في قاعدة بيانات Supabase Postgres**، بالإضافة لمحرك Graphify المعرفي (8,446 عقدة و19,690 علاقة).
3. المشكلة الهيكلية الكبرى تكمن في **Shared `db` Bag** في [container.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/container.js#L175-L185) الذي يمرر 9 Repositories معاً لـ 14 خدمة، ما أدّى إلى تسرّب الكتابة في جدول `public.workflow` من قِبل **8 مجالات مختلفة** وفي `public.media` من قِبل **9 أطراف**.
4. تم رصد **3 دوائر استيراد تزامنية رئيسية (Circular Dependencies)** وحلقة كبرى عبر `container.js` تشمل 15 ملفاً، إضافة لدائرتي Setters وقت التشغيل (Folder <-> Workflow وWorkflow <-> Character/Element).
5. تم تحديد **10 أنظمة أعمال مستقلة (Business Systems)** مقترحة بدقة، بحيث يملك كل نظام جداوله حصرياً ويعرض واجهة واحدة (`index.js`) عبر Alias صريح (`#<name>`).
6. تم دمج `Payments` داخل نظام `Billing` لتفادي تجزئة غير مبررة لنظام يملك جدولاً واحداً (`credit_packages`) وWebhook وحيد لـ LemonSqueezy.
7. تم فصل حاويات العمل كـ `WorkflowContainer` مستقل عن `Workspace` (المشاريع والمجلدات)، التزاماً بقاعدة **Workflow Freeze** ولحماية المشاريع من التشابك العالي للـ Workflows.
8. قطاع التسعير يحتوي على ازدواجية معمارية (Manifests vs `pricing_rules`)؛ تم حسم جمعه تحت نظام `Models` مع وسم جدول الـ DB كـ Tech Debt مؤجل الحذف، وتصدير أداة وحيدة: `calculateCost`.
9. طبقة الـ Read Models (`ProjectReadService` و`GenerationService.getLibrary`) لا تستخدم SQL Joins بل تقوم بتجميع البيانات في الذاكرة (Scatter-Gather)، وموضعها المستهدف هو `src/read-models/`.
10. خطة الـ Refactor المقترحة مبنية على **8 مراحل صغيرة وتدريجية** بدون تغيير في الـ Schema الحالية للـ DB، تبدأ بنظام **Workspace (المشاريع والمجلدات)** كنظام تجريبي آمن وقليل المخاطر.

---

## 2. جدول الـ Systems المقترحة (Proposed Business Systems)

| الـ System المستهدف | المسؤولية في جملة واحدة | الجداول / State المملوكة | الـ Tools العامة (Public Capabilities) | مستوى الثقة | التبرير من واقع الكود |
|---|---|---|---|---|---|
| **Identity** | إدارة تسجيل ودخول المستخدمين، الجلسات (JWT/Cookies)، الـ Profiles، والتحقق من أدوار الـ Admin. | `public.profiles` + Supabase `auth.users` | `signUp`, `signIn`, `resolveSessionUser`, `assertAdminRole` | **عالي** | معزول منطقياً في [authController.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/authController.js) و[auth.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/middleware/auth.js)، لا يشاركه أحد في `profiles`. |
| **Billing** | إدارة المحافظ المالية، الحجز والتسوية الذرية للرصيد (2-phase holds)، باقات الشحن، ومعالجة دفعات LemonSqueezy. | `wallets`, `transactions`, `usage_events`, `failed_wallet_operations`, `credit_packages` + 6 RPCs | `reserveCredits`, `commitHold`, `rollbackHold`, `creditWallet`, `getBalance`, `processPaymentWebhook` | **عالي** | محكوم بـ 6 إجراءات مخزنة ذرية ومفصول عملياً في [WalletService.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/platform/billing/WalletService.js) و[paymentsController.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/paymentsController.js). |
| **Storage** | إدارة التخزين الفيزيائي للوسائط (S3/Supabase)، مسارات الـ Keys، والروابط المؤقتة الموقعة. | **صفر جداول DB** (يملك Bucket `generated_images`) | `uploadBuffer`, `deleteFiles`, `createSignedDownloadUrls`, `validateFolder` | **عالي** | مغلق مسبقاً في Phase 1 كـ Platform Provider منعزل في [src/platform/storage/](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/platform/storage/). |
| **Media** | إدارة دورة حياة الوسائط الخام (`public.media`) والـ Placeholders والمعالجة الستاتلس للصور (Sharp WebP). | `public.media` | `uploadFiles`, `discardUploadedFiles`, `createMedia`, `createPlaceholders`, `markMediaFailed`, `deleteMediaRecord` | **عالي** | يملك جدول `public.media` حصرياً مع خط أنابيب الرفع الستاتلس في [MediaUploadService.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/platform/media-ingestion/MediaUploadService.js). |
| **Models** | الكتالوج الموحد لموديلات الذكاء الاصطناعي (21 Model Manifests و22 ملف bindings؛ منها 6 systemOnly و15 للـ media)، التحقق من الـ Schemas، حساب السعر المالي، وتنفيذ الـ Providers. | 21 Model Manifests (و22 bindings) + `public.pricing_rules` (Tech Debt) + `public.provider_credentials` | `getCatalog`, `getModelSchema`, `validateInput`, `calculateCost`, `runModel`, `reloadModels` | **عالي** | Facade موجود بالفعل في [src/models/index.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/models/index.js)، ويجمع كل ما يخص الـ AI Providers. |
| **Workspace** | إدارة مساحات عمل المشاريع للمستخدمين والشجرة الهرمية للمجلدات (العمق الأقصى 3). | `public.project`, `public.folders` | `listProjects`, `getOrCreateDefaultProject`, `createProject`, `createFolder`, `assertFolderUsable`, `assertProjectOwned` | **عالي** | جداول `project` و`folders` نقية ومفصولة في [ProjectService.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/project/ProjectService.js) و[FolderService.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/folder/FolderService.js). |
| **WorkflowContainer** | كروت الكانفاس، ربط الوسائط، الكفر، سلة المهملات | `public.workflow`, `public.workflow_media`, `public.trash`, `public.generation_config*` + 5 RPCs | `createContainer`, `createWithPlaceholders`, `attachMedia`, `unlinkMedia`, `trashContainers`, `restoreContainers` | **متوسط** | تشابك عالي (8 كُتّاب لجدول `workflow`) وخضوعه لشرط التجميد [BUSINESS_SYSTEMS_RULES.md](file:///c:/Users/jihad/Desktop/open%20art/docs/architecture/BUSINESS_SYSTEMS_RULES.md). |
| **Character** | إدارة شخصيات الـ AI (البيانات، سمات الـ Art Director، صور الـ Turnaround Sheet والتفاصيل). | `public.characters` | `createCharacter`, `getCharacter`, `updateCharacter`, `deleteCharacter`, `generateCharacterBio` | **عالي** | يملك جدول `public.characters` وقواعد أعمال مستقلة في [CharacterService.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/character/CharacterService.js). |
| **Element** | إدارة عناصر الـ Reference المرئية، حدود الصور المرجعية، واستخراج الـ DNA بـ Gemini Vision، وترجمة `@Element`. | `public.element` | `createElement`, `getElementById`, `analyzeElementVision`, `compileElementPrompt`, `assertUploadCapacity` | **عالي** | يملك جدول `public.element` وقواعد استخراج الـ DNA المرجعي في [ElementService.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/element/ElementService.js). |
| **Execution** | محرك تشغيل الـ AI: تصريف وتشغيل كروت الـ DAG (V2 Engine)، وتنسيق الـ Use Cases العالية مع الـ BullMQ والـ Billing. | `public.v2_workflow_runs`, `public.v2_workflow_run_nodes`, طابور `"v2-workflow-jobs"` | `requestMediaGeneration`, `compileWorkflow`, `submitWorkflowRun`, `executeQueuedJob` | **عالي** | يمثل الـ Orchestrator المركزي المنسق في [useCaseService.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/services/useCaseService.js) و[src/v2/](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/). |

---

## 3. تفصيل الـ Systems والـ Services المقترحة

### 1) نظام الهوية (Identity System) — `#identity`
- **المسؤولية:** التحقق من الهوية (Email/Password وOAuth PKCE)، إدارة ملف تعريف المستخدم (`profiles`)، وتعيين جلسة الـ Cookies والتحقق من رتبة الأدمن.
- **ما ليس مسؤولاً عنه:** التحقق من ملكية المشاريع أو الكروت (يترك لكل نظام مالك عبر `userId`).
- **الخدمات الداخلية والـ Repositories:**
  - `AuthService`: تسجيل الدخول والخروج وإنشاء الحسابات.
  - `SessionService`: قراءة وفك تشفير الـ Cookies وتجديد الـ JWT.
  - `ProfileRepository`: القراءة والتعديل على جدول `public.profiles`.
- **الـ Tools المصدرة:** `signUp`, `signIn`, `signOut`, `resolveSessionUser`, `assertAdminRole`.

### 2) نظام الفوترة والمدفوعات (Billing System) — `#billing`
- **المسؤولية:** الحفاظ على السلامة المالية للأرصدة عبر دورة 2-phase holds ذرية، بيع باقات الرصيد، ومعالجة Webhooks بوابات الدفع (LemonSqueezy)، والمطابقة اليومية للأرصدة.
- **ما ليس مسؤولاً عنه:** حساب تكلفة الموديلات (يتم طلبه من Models عبر `models.calculateCost` من قِبل الـ Orchestrator وليس من Billing).
- **الخدمات الداخلية والـ Repositories:**
  - `WalletService`: إدارة الحجز (`hold`)، التأكيد (`commit`)، الاسترجاع (`rollback`)، والشحن (`credit`).
  - `PaymentsService`: استخراج باقات الرصيد وإنشاء روابط LemonSqueezy.
  - `PaymentWebhookService`: التحقق من توقيع HMAC ومعالجة الشحن الفوري.
  - `FailedOpsService`: تسجيل وإعادة محاولة العمليات المالية المتعثرة.
  - `WalletRepository`, `TransactionRepository`, `UsageEventRepository`, `CreditPackageRepository`.
  - `walletQueue`: تعريف طابور الصيانة المالي `"wallet-maintenance"`.
  - `walletWorker`: معالجة مهام المطابقة وإلغاء الحجوزات وإعادة العمليات الفاشلة.
- **الـ Tools المصدرة:** `ensureWallet`, `reserveCredits`, `commitHold`, `rollbackHold`, `creditWallet`, `getBalance`, `listTransactions`, `createCheckoutSession`, `processPaymentWebhook`.

### 3) نظام التخزين الفيزيائي (Storage System) — `#storage`
- **المسؤولية:** التعامل المباشر مع مزودات التخزين السحابي (Supabase Storage / S3)، توفير Signed URLs، والتحقق من قيود المجلدات والامتدادات.
- **ما ليس مسؤولاً عنه:** معرفة أي بيانات عن جداول الـ Database أو أنواع الكروت.
- **الخدمات الداخلية:** `StorageService`, `SupabaseStorageProvider`, `InMemoryStorageProvider`, `StoragePathResolver`.
- **الـ Tools المصدرة:** `uploadBuffer`, `deleteFiles`, `createSignedUploadUrl`, `createSignedDownloadUrls`, `validateFolder`.

### 4) نظام الوسائط والرفع (Media System) — `#media`
- **المسؤولية:** المالك الحصري لجدول `public.media`. يتولى استلام الـ Binaries والتأكد من Magic Bytes وتحويلها لـ WebP عبر Sharp ورفعها للـ Storage، وإدارة سجلات الـ Media وحالاتها (`processing`, `success`, `failed`).
- **ما ليس مسؤولاً عنه:** ربط الوسائط بالكروت (مسؤولية WorkflowContainer عبر `workflow_media`).
- **الخدمات الداخلية:**
  - `MediaService`: العمليات على جدول `public.media`.
  - `MediaUploadService`: خط الأنابيب الستاتلس للرفع والمعالجة والـ Discard التعويضي.
  - `MediaInspector`: فحص ترويسات الملفات وتنسيق Sharp.
  - `SourceResolver` & `SourceReader`: قراءة الملفات وفك Base64 مع حماية SSRF.
  - `MediaRepository`: التعامل الحصري مع جدول `public.media`.
- **الـ Tools المصدرة:** `uploadFiles`, `discardUploadedFiles`, `createMedia`, `createPlaceholders`, `markMediaFailed`, `completeMediaPlaceholder`, `getMediaById`.

### 5) نظام إدارة الموديلات والتسعير (Models System) — `#models`
- **المسؤولية:** الكتالوج الموحد لكل موديلات الذكاء الاصطناعي (Image, Video, LLM)، التحقق من صحة المدخلات بـ Zod/Ajv، حساب تكلفة الرصيد بدقة، وتشغيل الـ Adapters الخارجية (WaveSpeed, Google GenAI, LTX).
- **التسعير المدمج:** يضم `pricingEngine.js` (المعتمد على الـ Manifests) بالإضافة لـ `PricingService.js` وجدول `public.pricing_rules` الذي تم وسمه كـ **Tech Debt** غير مستعمل في مسار التوليد الحالي.
- **الـ Tools المصدرة:** `getCatalog`, `getModelSchema`, `validateInput`, `calculateCost`, `runModel`, `reloadModels`.

### 6) مساحة العمل (Workspace System) — `#workspace`
- **المسؤولية:** إدارة مشاريع المستخدمين (`public.project`) وتوفير المشروع الافتراضي، وإدارة الشجرة الهرمية للمجلدات (`public.folders`) والتحقق من قيودها (العمق الأقصى 3 والعدد الأقصى 50 لكل مشروع).
- **ما ليس مسؤولاً عنه:** الكروت داخل المجلدات أو الوسائط.
- **الخدمات الداخلية:** `ProjectService`, `FolderService`, `folderTree.js`, `ProjectRepository`, `FolderRepository`.
- **الـ Tools المصدرة:** `listProjects`, `getOrCreateDefaultProject`, `createProject`, `assertProjectOwned`, `listFolders`, `createFolder`, `updateFolder`, `deleteFolder`, `assertFolderUsable`.

### 7) حاويات العمل وسلة المهملات (WorkflowContainer System) — `#workflow-container`
- **المسؤولية:** المالك الحصري لكروت الكانفاس (`public.workflow`)، وجدول الربط (`public.workflow_media`)، وإدارة الكفر الأساسي، وتنسيق الحذف المؤقت في سلة المهملات (`public.trash`) والحذف النهائي.
- **الخدمات الداخلية:**
  - `WorkflowContainerService`: تعديل وتفضيل الكروت.
  - `WorkflowMediaService`: ربط وفك الوسائط عبر الـ RPCs وحساب الحصص والكفر.
  - `TrashService`: عمليات النقل للسلة والاسترجاع.
  - `WorkflowRepository`, `WorkflowMediaRepository`, `TrashRepository`.
- **الـ Tools المصدرة:** `createContainer`, `createContainerWithPlaceholders`, `attachMedia`, `unlinkMedia`, `trashContainers`, `restoreContainers`, `assertContainerOwned`.

### 8) نظام الشخصيات (Character System) — `#character`
- **المسؤولية:** المالك لجدول `public.characters`. يدير بيانات الشخصيات الافتراضية، صور الـ Turnaround والـ Details، وتوليد وصف الـ Art-Director عبر استدعاء Models Tool.
- **الخدمات الداخلية:** `CharacterService`, `CharacterMediaService`, `CharacterDescriptionService`, `CharacterRepository`.
- **الـ Tools المصدرة:** `createCharacter`, `getCharacter`, `updateCharacter`, `deleteCharacter`, `generateCharacterBio`, `assertCharacterOwned`.

### 9) نظام العناصر المرجعية (Element System) — `#element`
- **المسؤولية:** المالك لجدول `public.element`. يدير العناصر المرجعية (Styles, Faces, Objects)، سعة الصور المرجعية، واستخراج الـ DNA البصري بـ Gemini Vision، وتصريف `@ElementName` داخل الـ Prompt.
- **الخدمات الداخلية:** `ElementService`, `ElementMediaService`, `ElementAnalysisService`, `PromptBuilderProService`, `ElementRepository`.
- **الـ Tools المصدرة:** `createElement`, `getElementById`, `listProjectElements`, `analyzeElementVision`, `compileElementPrompt`, `assertUploadCapacity`, `assertElementOwned`.

### 10) محرك التنفيذ والتنسيق (Execution System) — `#execution`
- **المسؤولية:** الـ Orchestrator المركزي في التطبيق. يدير دورة حياة الـ Use Cases (`image-generation-v1`، `video-generation-v1`...)، تصريف كروت الـ DAG بـ V2 Engine، تنسيق حجز الرصيد المالي مسبقاً وتأكيده عند النجاح واسترجاعه عند الفشل، وتوزيع المهام على طوابير BullMQ (`v2-workflow-jobs`).
- **الخدمات الداخلية:** `UseCaseService`, `GenerationRequestService`, `WorkflowRunner`, `NodeExecutor`, `CompileWorkflow`, `RunRepository`.
- **عامل التنفيذ (Worker):** `useCaseWorker` المخصص لمعالجة الطابور `"v2-workflow-jobs"`.
- **الـ Tools المصدرة:** `requestMediaGeneration`, `compileWorkflow`, `submitWorkflowRun`, `getWorkflowRunStatus`.

---

## 4. تحليل كُتّاب `public.workflow` الثمانية والـ Workflow Freeze

بناءً على الفحص البرمجي الدقيق، تم حصر الأطراف الثمانية التي تكتب حالياً في جدول `public.workflow` مباشرة، وتحديد الـ Tool المقابل، وموقفها من التجميد:

| # | الملف الحالي | الـ Function الحالية | نوع الكتابة المباشرة في الكود | الـ Tool البديل في `WorkflowContainer` | السلوك الواجب تجميده (Freeze Policy) |
|---|---|---|---|---|---|
| **1** | [WorkflowServiceBase.js:243](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/platform/workflow/WorkflowServiceBase.js#L243) | `patchWorkflow` | `this.db.workflows.client().from("workflow").update(...)` | `patchContainer(id, updates)` | **مجمّد:** منطق التحقق، تفضيل الكارت، والتعديل المباشر ممنوع تغييره. |
| **2** | [AssetUploadService.js:302](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/asset/AssetUploadService.js#L302) | `uploadAsset` | `this.db.workflows.createWorkflow({ workflow_type: 'UPLOAD', ... })` | `createContainer({ type: 'UPLOAD', ... })` | **مجمّد:** إنشاء حاوية الـ Upload عند رفع أصل مستقل يبقى بسلوكه الحالي. |
| **3** | [CharacterService.js:105](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/character/CharacterService.js#L105) | `createCharacter` | `this.db.workflows.createWorkflow({ workflow_type: 'CHARACTER_SHEET' })` | `createContainer({ type: 'CHARACTER_SHEET' })` | **مجمّد:** كارت الشخصية يُنشأ كحاوية Sheet؛ يمنع تعديل علاقة الكارت بالشخصية. |
| **4** | [ElementService.js:110](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/element/ElementService.js#L110) | `createElement` | `this.db.workflows.createWorkflow({ workflow_type: 'ELEMENT_SHEET' })` | `createContainer({ type: 'ELEMENT_SHEET' })` | **مجمّد:** كارت العنصر يُنشأ كحاوية Sheet مع المحافظة على الربط الحالي. |
| **5** | [ElementAnalysisService.js:156,260](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/element/ElementAnalysisService.js#L156) | `analyzeAndPersist` | Raw `supabase.from("workflow").update(...)` لتحديث الـ DNA والـ Description | `updateContainerMetadata(id, meta)` | **استثناء تعديل:** هذا التسرب يجب إيقافه فوراً لأنه يخرق حدود الـ Repository ويكتب Raw SQL. |
| **6** | [GenerationRequestService.js:45](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/generation/GenerationRequestService.js#L45) | `requestGeneration` | `this.db.workflows.createWorkflow({ workflow_type: 'GENERATION' })` | `createContainerWithPlaceholders(...)` | **مجمّد:** إنشاء كارت الـ Generation وتجهيز وسائطه المعلقة يجب أن يبقى متطابقاً 100%. |
| **7** | [GenerationService.js:520](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/generation/GenerationService.js#L520) | `mutateGeneration` | `this.db.workflows.updateWorkflow(...)` لتبديل حالة الـ Favorite | `toggleFavorite(id)` | **مجمّد:** سلوك تبديل الإعجاب يبقى ثابتاً ولكن يُنقل من خدمة الـ Generation لـ Container. |
| **8** | [v1StorageBridge.js:396](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/services/v1StorageBridge.js#L396) | `createWorkflowContainer` | `workflowMediaOps.createWorkflowWithPlaceholder(...)` | `createContainerWithPlaceholders(...)` | **مجمّد:** كوبري V2 ينشئ حاوية V1 للمخرجات؛ لا يتم المساس به إلا عند مرحلة V2. |

---

## 5. فحص الـ PL/pgSQL RPCs في قاعدة البيانات

تم فحص كافة الإجراءات المخزنة المستدعاة في الكود عبر `.rpc(...)` لمعرفة هل تلمس جداول نظام واحد أم تعبر الحدود:

### أ) إجراءات الفوترة (Billing RPCs — 6 إجراءات):
1. `hold_credits`: تلمس `wallets` (FOR UPDATE) و`transactions` (INSERT PENDING). **(نظام واحد: Billing)**.
2. `commit_transaction`: تلمس `transactions` (UPDATE COMPLETED). **(نظام واحد: Billing)**.
3. `rollback_transaction`: تلمس `transactions` (UPDATE FAILED) و`wallets` (استرجاع الرصيد). **(نظام واحد: Billing)**.
4. `credit_wallet`: تلمس `wallets` (إضافة رصيد) و`transactions` (INSERT CREDIT). **(نظام واحد: Billing)**.
5. `extend_hold`: تلمس `transactions` (تحديث `expires_at`). **(نظام واحد: Billing)**.
6. `expire_stale_holds`: تلمس `transactions` و`wallets` (إلغاء واسترجاع جماعي). **(نظام واحد: Billing)**.
- **الحكم على Billing RPCs:** نظيفة 100% ولا تخرق حدود أي نظام خارجي.

### ب) إجراءات الـ Workflow والوسائط (Workflow RPCs — 5 إجراءات):
1. `set_workflow_primary_media`: تلمس `public.workflow_media` حصراً لتبديل `is_primary`. **(نظام واحد: WorkflowContainer)**.
2. `set_workflow_primary_media_if_none`: تلمس `public.workflow_media` لتعيين كفر إذا لم يوجد. **(نظام واحد: WorkflowContainer)**.
3. **`attach_workflow_reference_media` (استثناء عابر للحدود):**
   - الكود المصدري في [20261020020000_atomic_attach_workflow_reference_media_rpc.sql](file:///c:/Users/jihad/Desktop/open%20art/supabase/migrations/20261020020000_atomic_attach_workflow_reference_media_rpc.sql#L53-L66) يقفل `public.workflow` بـ `FOR UPDATE` للتحقق من الحصة، ويقفل `public.media` بـ `FOR KEY SHARE` لمنع الحذف المتزامن، ويكتب في `public.workflow_media`.
   - **القرار المحسوم:** الإبقاء على الـ RPC في قاعدة البيانات كما هو لمنع الـ Race Conditions، وتعتبر مملوكة لـ `WorkflowContainer`.
4. **`unlink_workflow_media_and_reap_orphan` (استثناء عابر للحدود):**
   - الكود في [20261020030000_atomic_unlink_workflow_media_and_reap_orphan_rpc.sql](file:///c:/Users/jihad/Desktop/open%20art/supabase/migrations/20261020030000_atomic_unlink_workflow_media_and_reap_orphan_rpc.sql#L51-L75) يحذف من `workflow_media`، وإذا كان الوسيط يتيماً (remaining_links = 0) يحذفه مباشرة من `public.media`.
   - **القرار المحسوم:** الحفاظ على الـ RPC لضمان عدم وجود ملفات يتيمة دون تغيير الـ Schema، وتوثيق استدعائه داخل أداة `unlinkMedia` في WorkflowContainer.
5. **`create_workflow_with_placeholder_media`:**
   - يكتب في `workflow` و`media` و`workflow_media` في Transaction واحد.
   - **القرار المحسوم:** يبقى مستعملاً حصرياً في مسار إنشاء الـ Placeholders لضمان الذرية.

---

## 6. حصر العلاقات والـ Foreign Keys العابرة للأنظمة (Cross-System FKs)

من واقع فحص الـ 24 جدولاً وملفات الـ Migrations (`supabase/migrations/20261018161500_baseline.sql`)، تم حصر كافة الـ Foreign Keys العابرة للحدود:

| اسم القيد (FK Constraint) | الجدول والعمود المصدر | الجدول والعمود الهدف | النظام المصدر | النظام الهدف | كيفية التعامل معه في الـ Refactor |
|---|---|---|---|---|---|
| `fk_wallets_user` | `wallets.user_id` | `auth.users.id` | Billing | Identity | **نحافظ عليه مؤقتاً** في الـ DB؛ في الكود يتعامل كـ Plain UUID. |
| `usage_events_user_id_fkey` | `usage_events.user_id` | `auth.users.id` | Billing | Identity | **نحافظ عليه مؤقتاً**؛ في الكود يعتبر معرف مستخدم مجرد. |
| `characters_user_id_fkey` | `characters.user_id` | `auth.users.id` | Character | Identity | **نحافظ عليه مؤقتاً**؛ مرجعية مستخدم عادية. |
| `workflow_project_id_fkey` | `workflow.project_id` | `project.id` | WorkflowContainer | Workspace | **نحافظ عليه مؤقتاً**؛ التحقق من وجود المشروع يتم برمجياً عبر `workspace.assertProjectOwned`. |
| `media_project_id_fkey` | `media.project_id` | `project.id` | Media | Workspace | **نحافظ عليه مؤقتاً**؛ في الكود يتم تمرير `projectId` كـ UUID دون استعلام مباشر لجدول المشروع. |
| `characters_project_id_fkey` | `characters.project_id` | `project.id` | Character | Workspace | **نحافظ عليه مؤقتاً**؛ التحقق يتم عبر استدعاء Tool فحص ملكية المشروع. |
| `workflow_folder_same_project_fk`| `workflow(folder_id, project_id)` | `folders(id, project_id)` | WorkflowContainer | Workspace | **نحافظ عليه مؤقتاً**؛ فحص صلاحية المجلد يتم عبر أداة `workspace.assertFolderUsable`. |
| `characters_workflow_id_fkey` | `characters.workflow_id` | `workflow.id` | Character | WorkflowContainer | **نحافظ عليه مؤقتاً** (`ON DELETE SET NULL`)؛ الربط يتم بتمرير `workflowId`. |
| `element_workflow_id_fkey` | `element.workflow_id` | `workflow.id` | Element | WorkflowContainer | **نحافظ عليه مؤقتاً** (`ON DELETE SET NULL`)؛ الربط عبر Tool الحاوية. |
| `workflow_media_media_id_fkey` | `workflow_media.media_id` | `media.id` | WorkflowContainer | Media | **نحافظ عليه مؤقتاً**؛ يدار ذرياً بواسطة RPCs الحاوية. |
| `fk_workflow_primary_media` | `workflow.primary_media_id` | `media.id` | WorkflowContainer | Media | **نحافظ عليه مؤقتاً** (`ON DELETE SET NULL`)؛ تعيين الكفر يتم عبر أداة `setPrimaryCover`. |

> **قاعدة التعامل:** لا نقوم بحذف أي FK من قاعدة البيانات في هذه المرحلة لتفادي أي تغيير في سلوك الـ Integrity أو الـ Cascades الحالي، بينما في كود الـ Node.js يتم حظر أي `JOIN` مباشر بين هذه الجداول، ويتم التعامل مع المفاتيح كـ Plain IDs تمرر لـ Tools الأنظمة المالكة.

---

## 7. معمارية طبقة الـ Read Model (CQRS Read Facade)

### أ) واقع الكود الحالي:
أثبت فحص ملف [ProjectReadService.js:97-190](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/project/ProjectReadService.js#L97) و[GenerationService.js:64-120](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/generation/GenerationService.js#L64) أن الكود **لا يستخدم SQL Joins مباشرة** لجلب بيانات الشاشات المركبة، بل يعتمد على نمط **Scatter-Gather في الذاكرة**:
1. جلب بيانات المشروع والمجلدات.
2. جلب الـ Workflows التابعة للمشروع بالتوازي مع الـ Media.
3. جلب الـ Elements والـ Characters وعلاقات `workflow_media` بشكل متوازي عبر `Promise.all`.
4. دمج وتنسيق البيانات في مصفوفات وخرائط داخل Node.js وإرجاع الـ DTO النهائي للواجهة.

### ب) الموضع المستهدف:
الموضع المعتمد هو: `src/read-models/`، حيث يوضع:
- `src/read-models/ProjectReadService.js` (لشاشة الكانفاس `/project-data/:id`).
- `src/read-models/LibraryReadService.js` (لشاشة المكتبة `/library` وتصفح الأصول).

### ج) القرار المحسوم:
- اعتماد **التجميع عبر Tools (Aggregation via Tools)** مع قياس الـ latency قبل وبعد النقل للتأكد من عدم حدوث أي تراجع في الأداء.

---

## 8. توثيق وحسم نظام التسعير (Pricing Debt Analysis)

1. **مسار التسعير الفعلي المعتمد في التوليد:**
   - ملف [src/models/pricing/pricingEngine.js](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/models/pricing/pricingEngine.js) هو السلطة الحقيقية لحساب التكلفة.
   - يستدعى عبر `models.calculateCost(...)` في:
     - [src/use-cases/workflowBillingPlan.js:93](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/use-cases/workflowBillingPlan.js#L93) لحساب خطة الفوترة المسبقة.
     - [src/services/useCaseService.js:80](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/services/useCaseService.js#L80) قبل حجز رصيد التوليد.
     - [routes/modelsRoute.js:150](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/routes/modelsRoute.js#L150) في endpoint الاقتباس `POST /api/models/:key/quote`.
2. **جدول `public.pricing_rules` و`PricingService.js` (توصيف الـ Tech Debt):**
   - **الوسم:** `Tech Debt: غير مستعمل في مسار التوليد الفعلي؛ قرار حذفه أو تفعيله كـ DB Override مؤجل كقرار منتج.`
   - **من يقرأه:** [PricingService.js:60](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/models/pricing/PricingService.js#L60) و[walletController.js:158](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/walletController.js#L158) في المسار `GET /api/wallet/price`.
   - **من يكتب فيه:** [PricingService.js:110](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/models/pricing/PricingService.js#L110) و[adminController.js:242](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/adminController.js#L242) في المسار `PATCH /api/admin/pricing/:id`.
3. **الإجراء المعماري:**
   - يوضع `PricingService.js` داخل `src/systems/models/services/` ويظل مربوطاً بمسارات الأدمن ومسار المحفظة، بينما يصدر نظام Models أداة وحيدة هي `calculateCost`.

---

## 9. المخالفات الحالية مرتبة حسب الخطورة (Current Violations)

### أ) خطورة عالية (High Severity)
1. **الكتابة المباشرة في جدول `workflow` من خارج النظام:**
   - الدليل: [ElementAnalysisService.js:156,260](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/element/ElementAnalysisService.js#L156) يستدعي `supabase.from("workflow").update(...)`، و[AssetUploadService.js:302](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/asset/AssetUploadService.js#L302) يستدعي `db.workflows.createWorkflow`.
2. **الكتابة المباشرة في جدول `media` وتجاوز `MediaService`:**
   - الدليل: 9 خدمات وعمال يستدعون `db.media` مباشرة بدلاً من `MediaService`، مثل [useCaseWorker.js:131](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/workers/useCaseWorker.js#L131) و[nodeExecutor.js:108](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/runner/nodeExecutor.js#L108).
3. **كوبري V2 يخرق حدود جداول الشخصيات والمشاريع:**
   - الدليل: [v1StorageBridge.js:110,396](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/v2/services/v1StorageBridge.js#L110) يقوم بـ Raw INSERT في جدول `characters` وجدول `project` بأسماء وحقول Hardcoded.
4. **تسرب الـ Controller واستيراد Repositories مباشرة:**
   - الدليل: [controllers/v2/workflowsController.js:12](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/v2/workflowsController.js#L12) يستدعي `new RunRepository()` مباشرة داخل متحكم HTTP.
5. **منطق الـ Business وقواعد البيانات داخل الـ Controllers:**
   - الدليل: [controllers/authController.js:89](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/authController.js#L89) و[controllers/paymentsController.js:55](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/paymentsController.js#L55) يستدعيان Supabase Auth وDB مباشرة دون وجود طبقة Service أو Repository.

### ب) خطورة متوسطة (Medium Severity)
1. **استيراد `req` كائن الـ HTTP داخل خدمات الـ Domain والـ Platform:**
   - الدليل: [WorkflowServiceBase.js:259](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/platform/workflow/WorkflowServiceBase.js#L259) يستقبل `req` في دالة `patchWorkflow`، و[TrashService.js:57](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/trash/TrashService.js#L57) يستقبل `req`.
2. **حلقات تزامنية وتعيين Setters ثنائية الاتجاه:**
   - الدليل: `FolderService <-> WorkflowService` عبر `setWorkflowService` في [container.js:211](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/container.js#L211)، و`WorkflowService <-> Character/Element` عبر `setEntitySyncHandlers` في [container.js:257](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/container.js#L257).
3. **تكرار منطق فحص الملكية العام (God Ownership Helper):**
   - الدليل: [src/platform/security/ownership.js:235-265](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/platform/security/ownership.js#L235) يستعلم مباشرة عن 6 جداول تابعة لـ 6 مجالات مختلفة في ملف أمني عام.
4. **تكرار كود التحقق بين Image وVideo Controllers بنسبة 95%:**
   - الدليل: [imageController.js:9-100](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/imageController.js#L9) و[videoController.js:9-90](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/videoController.js#L9) مكرران سطراً بسطر.

### ج) خطورة منخفضة (Low Severity / Technical Debt)
1. **وجود 12 ملف كود ميتة تماماً دون أي استيراد إنتاجي:** (انظر القسم 12).
2. **خلل في تسمية مفتاح Redis للمطابقة المالية اليومية:**
   - الدليل: العامل [walletWorker.js:315](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/workers/walletWorker.js#L315) يكتب `"reconcile:latest"` بينما الـ Controller [adminController.js:179](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/controllers/adminController.js#L179) يقرأ `"reconciliation:latest"`.
3. **تكرار تشغيل الـ Reaper في ثلاثة مواضع:**
   - الدليل: تايمر 10 دقائق في [index.js:249](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/index.js#L249)، تايمر 5 دقائق في [worker.js:29](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/workers/worker.js#L29)، ومهمة مكررة في [walletQueue.js:44](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/queue/walletQueue.js#L44).

---

## 10. مصفوفة الاعتماديات والدوائر (Dependency Matrix & Cycles)

### أ) مصفوفة الاتجاهات المصححة بين الـ Systems:

| النظام الطالب (Caller) ↓ \ المستدعى (Callee) → | Identity | Billing | Storage | Media | Models | Workspace | WorkflowContainer | Character | Element | Execution |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Identity** | — | ❌ *(خيار Lazy/Controller)* | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Billing** | ❌ | — | ❌ | ❌ | ❌ *(تم شطب السهم)* | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Storage** | ❌ | ❌ | — | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Media** | ❌ | ❌ | Tool | — | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Models** | ❌ | ❌ | ❌ | ❌ | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Workspace** | ❌ | ❌ | ❌ | ❌ | ❌ | — | ❌ | ❌ | ❌ | ❌ |
| **WorkflowContainer** | ❌ | ❌ | Tool | Tool | ❌ | Tool (`assertUsable`) | — | ❌ | ❌ | ❌ |
| **Character** | ❌ | ❌ | ❌ | Tool | Tool (`LLM`) | Tool (`assertOwned`) | Tool (`createContainer`) | — | ❌ | ❌ |
| **Element** | ❌ | ❌ | ❌ | Tool | Tool (`Vision`) | Tool (`assertOwned`) | Tool (`createContainer`) | ❌ | — | ❌ |
| **Execution** | ❌ | Tool (`reserve/commit`) | Tool | Tool | Tool (`run/cost`) | Tool (`assertOwned`) | Tool (`placeholders`) | Tool | Tool | — |

### ب) تصحيحات وتوضيحات الاعتماديات الإلزامية:

1. **تصحيح سهم `Billing ──▶ Models` (تم الشطب بالدليل):**
   - في الكود الحالي، لا يوجد أي ملف داخل `src/platform/billing/` يستورد `models` أو ينادي `calculateCost`.
   - الاستدعاءات موجودة فقط في:
     - `src/use-cases/workflowBillingPlan.js:93` (Execution)
     - `src/services/useCaseService.js:80` (Execution)
     - `routes/modelsRoute.js:150` (Routes)
   - بالتالي تم شطب السهم تماماً، ونظام `Billing` أصبح لا يكلم أي نظام آخر (نظام تأسيسي مغلق).

2. **معالجة سهم `Identity ──▶ Billing` (`ensureWallet`):**
   - استدعاء `Identity` لـ `Billing` عند التسجيل يخالف القاعدة 8 ("الأنظمة الصغيرة لا تنادي الكبار").
   - **الخيارات المعمارية:**
     - *الخيار 1 (Lazy Creation في Billing — الموصى به):* نظام Billing يضمن إنشاء المحفظة تلقائياً عند أول استدعاء لـ `getBalance` أو `hold` أو `credit`. هذا يعزل Identity بنسبة 100% ويجعلها بلا أي تبعيات خارجية.
     - *الخيار 2 (Controller / Application Use Case):* في مسار التسجيل `POST /api/auth/signup`، يقوم الـ Controller بمناداة `identity.signUp` ثم مناداة `billing.ensureWallet(userId)` تباعاً.
   - 👉 **التوصية:** اعتماد **الخيار 1** لكونه fail-safe ويمنع حالات تعطل التسجيل إذا واجهت الفوترة أي بطء.

3. **توافق `Character` و`Element ──▶ WorkflowContainer` مع القاعدة 8:**
   - وفقاً لتصنيف الطبقات في `BACKEND_ARCHITECTURE.md`:
     - `Character` و`Element` هما **Tier 3 (Upper Domain Systems)**.
     - `WorkflowContainer` هو **Tier 2 (Asset Container)**.
   - اتصال الكيان الأعلى بالحاوية الأدنى لإنشاء كارت (`createContainer`) أو ربط وسائط (`attachMedia`) يتوافق 100% مع الاتجاه الهابط (Downward Dependency).
   - المخالفة السابقة كانت في الاتجاه العكسي (الصاعد) عبر `setEntitySyncHandlers` حيث كان الـ Container ينادي Character وElement، وتم إلغاء هذا الاتجاه تماماً.

---

## 11. نتائج Graphify المعرفية (Knowledge Graph Insights)

تم تحديث الـ Graph في `graphify-out/` بنجاح (تاريخ 2026-11-04):
- **إحصائيات الـ Graph:** 8,446 عقدة، 19,690 علاقة، 585 مجتمع (Communities).
- **أهم 10 God Nodes في الـ Backend:**
  1. `WorkflowMediaService` (72 علاقة): المركز العصبي لربط وحذف الوسائط والكفر وحصص الكروت.
  2. `createLogger()` (90 علاقة): البنية المشتركة للتسجيل المهيكل (Logging Platform).
  3. `db` (Container Bag): العقدة الجامعة لجميع الـ Repositories والتي تسبب حلقة الـ 15 ملفاً.
  4. `MediaLifecycleService`: العقدة التي تربط بين الـ Placeholders وكوبري V2.
  5. `WalletService`: المحور المالي لكافة عمليات الحجز والتسوية.
  6. `models/index.js`: البوابة الحصرية لتنفيذ الموديلات والتسعير.
  7. `ownership.js` (`assertOwns`): العقدة الأمنية التي تتقاطع مع 6 مجالات.
  8. `JobQueueService`: ممر توزيع المهام لطابور BullMQ.
  9. `ProjectReadService`: العقدة التجميعية لبيانات الكانفاس.
  10. `ElementService`: المجمع الرئيسي لعمليات العناصر المرجعية والـ DNA.
- **الروابط المستنتجة (INFERRED Edges):**
  - تم فحص وتأكيد علاقة الـ Permanent Delete بين `TrashService` و`elementController.deleteElement` و`characterController.deleteCharacter`، وتبيّن أنها تُدار برمجياً عبر الـ Dispatcher داخل `TrashService.js:45-60`.

---

## 12. خطة الـ Refactor المرحلية المنظمة (المراحل 0 إلى 8)

### المرحلة 0: النظافة وحذف الـ 12 ملفاً ميتة وتفعيل الـ Ratchet
- **النطاق:** حذف الـ 12 ملفاً ميتة المؤكدة (المذكورة تفصيلاً في `architecture-functions-map.md`)، وتفعيل قواعد `arch-check.cjs` لمنع أي Deep Import جديد.
- **الحجم:** صغير (Small).
- **التحقق:** `npm run gate` يمر بنجاح تام.

### المرحلة 0ب: إصلاحات السلوك في Commits مستقلة
- **Commit 1:** توحيد الـ Reaper وحذف تايمر `index.js:249` (10 دقائق) مع إبقائه في `worker.js`.
- **Commit 2:** تصحيح مفتاح Redis للمطابقة في [walletWorker.js:315](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/workers/walletWorker.js#L315) ليطابق `adminController.js` (`"reconciliation:latest"`).
- **التحقق:** اختبارات المطابقة والـ Reaper.

### المرحلة 1 (الـ Pilot المعتمد): مساحة العمل (Workspace System)
- **النطاق:** نقل `ProjectService`, `FolderService`, `ProjectRepository`, `FolderRepository` إلى `src/systems/workspace/` مع Alias `#workspace`.
- **فك حلقة المجلدات:** استخراج إخلاء الكروت إلى Application Use Case (`DeleteFolderUseCase`) دون المساس بـ `FolderService`.
- **الحجم:** صغير (Small) ومغطى بـ 19 اختباراً.

### المرحلة 2: عزل نظام الهوية (Identity System)
- **النطاق:** إنشاء `src/systems/identity/` واستخراج `AuthService` و`ProfileRepository`، وتطبيق خيار Lazy Wallet Creation لعزل Identity عن Billing.
- **الحجم:** صغير - متوسط.

### المرحلة 3: توحيد نظام الفوترة والمدفوعات (Billing System)
- **النطاق:** إنشاء `src/systems/billing/`، نقل `WalletService` ودمج `paymentsController` كخدمة `PaymentsService` داخلية، ونقل `walletQueue` و`walletWorker`.
- **الحجم:** متوسط (Medium) مع تجميد توقيعات الـ 6 RPCs.

### المرحلة 4: إحكام نظام الموديلات والتسعير (Models System)
- **النطاق:** اعتماد `src/systems/models/`، فك حلقة `catalogPresentation.js`، ونقل `PricingService.js` كخدمة تسعير قديمة موسومة بـ Tech Debt.
- **الحجم:** صغير (Small).

### المرحلة 5: استكمال نظام الوسائط (Media System)
- **النطاق:** نقل `MediaService` و`MediaUploadService` تحت `src/systems/media/`، وحظر الاستدعاء الخارجي المباشر لـ `db.media`.
- **الحجم:** متوسط (Medium).

### المرحلة 6: عزل نظامي العناصر والشخصيات (حل معضلة الترتيب)
- **المعضلة:** تحتاج خدمات Character وElement لإنشاء حاويات كروت عبر `createContainer`، بينما ترحيل `WorkflowContainer` الكامل مؤجل للمرحلة 7.
- **الحل المعماري المقترح (Facade-First):**
  - في بداية المرحلة 6، ننشئ ملف الواجهة `src/systems/workflow-container/index.js` كـ **Thin Facade** يصدر Tool اسمها `createContainer` تغلف كود `WorkflowServiceBase` و`WorkflowRepository` الحالي كما هو وبسلوكه المجمّد.
  - نقوم بعزل Character وElement بالكامل وربطهما بالـ Tool الرسمية `#workflow-container`.
  - في المرحلة 7، يتم إعادة تنظيم ونقل الـ internals الخاصة بـ WorkflowContainer خلف هذه الواجهة المستقرة دون المساس بـ Character أو Element.
- **الحجم:** متوسط (Medium).

### المرحلة 7: عزل حاويات العمل وسلة المهملات (WorkflowContainer System)
- **ملاحظة:** تتطلب موافقة صريحة وفق قاعدة **Workflow Freeze**.
- **النطاق:** نقل كروت الـ Workflow و`workflow_media` وسلة المهملات، وتنظيف الـ internals خلف الـ Facade المنشأ في المرحلة 6.
- **الحجم:** كبير (Large).

### المرحلة 8: محرك التنفيذ، الـ Read Models، وتطهير الحاوية
- **النطاق:** نقل V2 Engine وUse Cases تحت `src/systems/execution/`، نقل شاشات القراءة إلى `src/read-models/`، ونقل مسارات HTTP إلى `src/routes/`، وإلغاء `export const db` نهائياً من `container.js`.
- **الحجم:** كبير (Large).

---

## 13. إجابات الأسئلة المعمارية الأربعة المحددة

### س1: شنوّة يصير في `src/workers/` (`useCaseWorker` و`walletWorker` و`worker.js`) و`src/queue/walletQueue.js`؟
- **التحليل من واقع الكود:**
  - `src/queue/walletQueue.js` هو طابور مخصص حصرياً للعمليات المالية (`wallet-maintenance`). **مكانه المستهدف:** ينتقل داخل نظام الفوترة: `src/systems/billing/queue/walletQueue.js`.
  - `src/workers/walletWorker.js` هو المستهلك الحصري لهذا الطابور. **مكانه المستهدف:** ينتقل لـ `src/systems/billing/workers/walletWorker.js`.
  - `src/workers/useCaseWorker.js` و`worker.js` هما المستهلكان لطابور توليد الـ AI والتنفيذ (`v2-workflow-jobs`). **مكانهما المستهدف:** ينتقلان لـ `src/systems/execution/workers/`.
  - `src/workers/reservationReaperWorker.js` هي مهمة تسوية مالية ووسائطية مشتركة تتبع `src/systems/billing/workers/`.
- **كيف تشتغل الـ Processes (الـ Entrypoints):**
  - للحفاظ على توافق أوامر `npm run start:worker` و`npm run start:wallet-worker` في `package.json` وتفادي كسر إعدادات الـ Docker / Deployment الحالية، تبقى ملفات تشغيل خفيفة جداً في `src/workers/` (مثل `src/workers/worker.js` و`src/workers/walletWorker.js`) تقتصر على استيراد وبدء العمال من أماكنهم الجديدة في `#execution` و`#billing`.

### س2: شنوّة يصير في `routes/` الموجودة في الـ root (مثل `modelsRoute.js`) بالنسبة لـ `src/routes/` الجديدة؟
- **التحليل من واقع الكود:**
  - حالياً، يوجد تشتت بين `apiOpenArt/routes/` في الـ root (19 ملفاً) و`apiOpenArt/controllers/` (17 ملفاً). وبعض الملفات مثل `routes/modelsRoute.js` و`routes/prompt.js` تحتوي على منطق Controller كامل مدمج داخل ملف الـ Route.
  - **الحل المعتمد وفق `BACKEND_ARCHITECTURE.md`:**
    - يتم **دمج الـ Routes والـ Controllers** في طبقة موحدة هي `src/routes/`.
    - تصبح الملفات في `src/routes/` عبارة عن **Thin HTTP Controllers** فقط: تستقبل الـ Request، تفحص المدخلات، تستدعي أداة الـ System المناسبة (`#models`, `#workspace`...)، وترجم النتيجة أو الخطأ لـ HTTP Status Code مناسب.
    - تختفي ملفات `controllers/` القديمة ومجلد `routes/` في الـ root كلياً من المشروع بنهاية المرحلة 8.

### س3: شنوّة يصير في `index.js` الـ root؟
- **التحليل من واقع الكود:**
  - `apiOpenArt/index.js` يخلط حالياً بين إعداد تطبيق Express (CORS, Middlewares, Routes, Error Handlers) وبين كونه Process Launcher (يستدعي `app.listen` ويبدأ تايمر الـ Reaper).
  - **الحل المعتمد:**
    - يُفصل إعداد الـ Express App بالكامل داخل `src/app.js` (تجميع الميدلوير والراوتس ومعالجة الأخطاء).
    - يبقى `apiOpenArt/index.js` في الـ root كـ **Process Launcher رقيق جداً** (Bootstrapper): يستورد `app` من `src/app.js`، ينادي `app.listen(PORT)`، ويدير إشارات الإغلاق النظيف (Graceful Shutdown).
    - هذا الفصل يحمي أوامر `npm start` و`nodemon index.js` من الانكسار، ويسمح في نفس الوقت باختبار Express App في الـ Integration Tests بدون فتح منافذ شبكة حقيقية (`supertest(app)`).

### س4: دايرة `FolderService ↔ WorkflowService` (حذف مجلد): Use Case على مستوى التطبيق، ولا `ON DELETE SET NULL`؟ وبيان الاختلاف في السلوك.
- **فحص الكود والـ Database:**
  - في الكود الحالي ([FolderService.js:356-362](file:///c:/Users/jihad/Desktop/open%20art/apiOpenArt/src/domain/folder/FolderService.js#L356)):
    عند حذف مجلد، يستدعي `workflowService.deleteWorkflowsInFolders`، وهذه الأخيرة تقوم بـ **حذف نهائي وشامل لكافة الـ Workflows الموجودة داخل المجلد وشجرته، وتنظيف وسائطها من الـ Storage والـ DB**!
  - في الـ Database ([20261018161500_baseline.sql:1157](file:///c:/Users/jihad/Desktop/open%20art/supabase/migrations/20261018161500_baseline.sql#L1157)):
    القيد هو:
    `FOREIGN KEY ("folder_id", "project_id") REFERENCES "public"."folders"("id", "project_id")`
    وهو قيد افتراضي (`RESTRICT` / `NO ACTION`) وليس `ON DELETE SET NULL` ولا `CASCADE`.
- **الفارق الجوهري في السلوك:**
  1. **إذا اعتمدنا `ON DELETE SET NULL` في الـ DB:**
     حذف المجلد سيؤدي إلى **بقاء الكروت ونقلها للجذر (`folder_id = null`)** دون حذفها. هذا تغيير جذري في سلوك الـ Product والبيانات!
  2. **إذا اعتمدنا Application Use Case (`DeleteFolderUseCase`):**
     نحافظ على سلوك التطبيق الحالي 100%: تقوم الـ Use Case بتنسيق الخطوات:
     أ) مناداة `workflowContainer.deleteWorkflowsInFolders(treeIds)` لحذف الكروت وتنظيف وسائطها.
     ب) مناداة `workspace.deleteFolder(folderId)` لحذف المجلد وشجرته بعد إخلائه.
- **التوصية الحاسمة:** اعتماد **Application Use Case (`DeleteFolderUseCase`)**؛ لأنها تكسر حلقة الـ Setter بين `FolderService` و`WorkflowService` فوراً، وتلتزم بقاعدة المرحلة الصارمة: **"الـ refactor ينظّم الحدود برك، ما يبدّلش منطق الـ business ولا شكل الـ database"**.

---

## 14. القرارات المفتوحة للتشاور والتوصيات

1. **حسم علاقة `Identity ──▶ Billing` عند التسجيل:**
   - *الخيار أ (توصيتي):* **Lazy Wallet Creation**؛ نظام الفوترة ينشئ المحفظة تلقائياً عند أول استدعاء مالي، فتبقى Identity مستقلة تماماً ومغلقة.
   - *الخيار ب:* قيام الـ Controller في `authRoutes.js` باستدعاء `identity.signUp` ثم `billing.ensureWallet`.
2. **حل معضلة ترتيب المرحلة 6 (Character/Element) والمرحلة 7 (WorkflowContainer):**
   - *الخيار أ (توصيتي):* **Facade-First**؛ إنشاء واجهة `src/systems/workflow-container/index.js` رقيقة في المرحلة 6 تعرض أداة `createContainer` وتغلف الكود المجمّد الحالي، ثم عزل Character وElement نظيفاً، وتأجيل تفكيك كود Workflow الداخلي للمرحلة 7.
   - *الخيار ب:* تقديم المرحلة 7 قبل المرحلة 6 وعزل WorkflowContainer أولاً (يتطلب موافقة صريحة على رفع التجميد مبكراً).
3. **تسمية مسار الـ Read Models:**
   - *الخيار أ (توصيتي):* اعتماد المسار الموثق `src/read-models/` ليعكس نمط CQRS Read Projections.
   - *الخيار ب:* اعتماد `src/queries/`.
