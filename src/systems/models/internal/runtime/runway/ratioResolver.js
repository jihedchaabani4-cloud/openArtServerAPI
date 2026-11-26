/**
 * Runway Ratio Resolver
 *
 * Translates canonical (aspect_ratio, resolution) inputs into the exact
 * `<width>:<height>` or `auto*` ratio strings accepted by each Runway API
 * model & endpoint in @runwayml/sdk v4.29.0.
 */

const EXACT_RATIO_RE = /^\d+:\d+$/;
const AUTO_RATIO_RE = /^auto(?:_(?:480p|720p|1080p|1k|1\.5k|2k|4k))?$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Shared Resolution × Aspect-Ratio Tables (exact literals from @runwayml/sdk)
// ─────────────────────────────────────────────────────────────────────────────

const GEN4_IMAGE_RATIOS = {
  "720p": {
    "1:1": "720:720",
    "16:9": "1280:720",
    "9:16": "720:1280",
    "4:3": "960:720",
    "3:4": "720:960",
    "21:9": "1680:720",
  },
  "1080p": {
    "1:1": "1080:1080",
    "16:9": "1920:1080",
    "9:16": "1080:1920",
    "4:3": "1440:1080",
    "3:4": "1080:1440",
    "21:9": "2112:912",
  },
  "1k": {
    "1:1": "1024:1024",
    "16:9": "1360:768",
    "9:16": "1080:1920",
    "4:3": "1168:880",
    "3:4": "1080:1440",
    "21:9": "1808:768",
  },
  defaultTier: "1080p",
  fallback: "1920:1080",
};

const GPT_IMAGE_RATIOS = {
  "1k": {
    "1:1": "1920:1920",
    "16:9": "1920:1088",
    "9:16": "1088:1920",
    "3:2": "1920:1280",
    "2:3": "1280:1920",
    "4:3": "1920:1440",
    "3:4": "1440:1920",
    "5:4": "1920:1536",
    "4:5": "1536:1920",
    "21:9": "2048:880",
  },
  "2k": {
    "1:1": "2560:2560",
    "16:9": "2560:1440",
    "9:16": "1440:2560",
    "3:2": "2560:1712",
    "2:3": "1712:2560",
    "4:3": "2560:1920",
    "3:4": "1920:2560",
    "5:4": "2560:2048",
    "4:5": "2048:2560",
    "21:9": "2912:1248",
  },
  "4k": {
    "1:1": "2880:2880",
    "16:9": "3840:2160",
    "9:16": "2160:3840",
    "3:2": "3504:2336",
    "2:3": "2336:3504",
    "4:3": "3264:2448",
    "3:4": "2448:3264",
    "5:4": "3200:2560",
    "4:5": "2560:3200",
    "21:9": "3840:1648",
  },
  defaultTier: "1k",
  fallback: "1920:1920",
};

const GEMINI_IMAGE_3_1_FLASH_RATIOS = {
  "0.5k": {
    "1:1": "512:512",
    "2:3": "416:624",
    "3:2": "624:416",
    "3:4": "432:592",
    "4:3": "592:432",
    "4:5": "448:576",
    "5:4": "576:448",
    "9:16": "384:672",
    "16:9": "672:384",
    "21:9": "768:336",
    "1:4": "256:1024",
    "4:1": "1024:256",
    "1:8": "176:1408",
    "8:1": "1408:176",
  },
  "1k": {
    "1:1": "1024:1024",
    "2:3": "832:1248",
    "3:2": "1248:832",
    "3:4": "864:1184",
    "4:3": "1184:864",
    "4:5": "896:1152",
    "5:4": "1152:896",
    "9:16": "768:1344",
    "16:9": "1344:768",
    "21:9": "1536:672",
    "1:4": "512:2048",
    "4:1": "2048:512",
    "1:8": "352:2816",
    "8:1": "2816:352",
  },
  "2k": {
    "1:1": "2048:2048",
    "2:3": "1696:2528",
    "3:2": "2528:1696",
    "3:4": "1792:2400",
    "4:3": "2400:1792",
    "4:5": "1856:2304",
    "5:4": "2304:1856",
    "9:16": "1536:2752",
    "16:9": "2752:1536",
    "21:9": "3168:1344",
    "1:4": "1024:4096",
    "4:1": "4096:1024",
    "1:8": "704:5632",
    "8:1": "5632:704",
  },
  "4k": {
    "1:1": "4096:4096",
    "2:3": "3392:5056",
    "3:2": "5056:3392",
    "3:4": "3584:4800",
    "4:3": "4800:3584",
    "4:5": "3712:4608",
    "5:4": "4608:3712",
    "9:16": "3072:5504",
    "16:9": "5504:3072",
    "21:9": "6336:2688",
    "1:4": "2048:8192",
    "4:1": "8192:2048",
    "1:8": "1408:11264",
    "8:1": "11264:1408",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const GEMINI_IMAGE_3_1_FLASH_LITE_RATIOS = {
  "1k": {
    "1:1": "1024:1024",
    "2:3": "848:1264",
    "3:2": "1264:848",
    "3:4": "896:1200",
    "4:3": "1200:896",
    "4:5": "928:1152",
    "5:4": "1152:928",
    "9:16": "768:1376",
    "16:9": "1376:768",
    "21:9": "1584:672",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const GEMINI_IMAGE_3_PRO_RATIOS = {
  "1k": {
    "1:1": "1024:1024",
    "2:3": "832:1248",
    "3:2": "1248:832",
    "3:4": "864:1184",
    "4:3": "1184:864",
    "4:5": "896:1152",
    "5:4": "1152:896",
    "9:16": "768:1344",
    "16:9": "1344:768",
    "21:9": "1536:672",
  },
  "2k": {
    "1:1": "2048:2048",
    "2:3": "1696:2528",
    "3:2": "2528:1696",
    "3:4": "1792:2400",
    "4:3": "2400:1792",
    "4:5": "1856:2304",
    "5:4": "2304:1856",
    "9:16": "1536:2752",
    "16:9": "2752:1536",
    "21:9": "3168:1344",
  },
  "4k": {
    "1:1": "4096:4096",
    "2:3": "3392:5056",
    "3:2": "5056:3392",
    "3:4": "3584:4800",
    "4:3": "4800:3584",
    "4:5": "3712:4608",
    "5:4": "4608:3712",
    "9:16": "3072:5504",
    "16:9": "5504:3072",
    "21:9": "6336:2688",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const GEMINI_2_5_FLASH_IMAGE_RATIOS = {
  "1k": {
    "1:1": "1024:1024",
    "2:3": "832:1248",
    "3:2": "1248:832",
    "3:4": "864:1184",
    "4:3": "1184:864",
    "4:5": "896:1152",
    "5:4": "1152:896",
    "9:16": "768:1344",
    "16:9": "1344:768",
    "21:9": "1536:672",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const NANO_BANANA_2_1_RATIOS = {
  "1k": {
    "1:1": "1024:1024",
    "2:3": "848:1264",
    "3:2": "1264:848",
    "3:4": "896:1200",
    "4:3": "1200:896",
    "4:5": "928:1152",
    "5:4": "1152:928",
    "9:16": "768:1376",
    "16:9": "1376:768",
    "21:9": "1584:672",
    "1:4": "512:2064",
    "4:1": "2064:512",
    "1:8": "352:2928",
    "8:1": "2928:352",
  },
  "2k": {
    "1:1": "2048:2048",
    "2:3": "1696:2528",
    "3:2": "2528:1696",
    "3:4": "1792:2400",
    "4:3": "2400:1792",
    "4:5": "1856:2304",
    "5:4": "2304:1856",
    "9:16": "1536:2752",
    "16:9": "2752:1536",
    "21:9": "3168:1344",
    "1:4": "1024:4128",
    "4:1": "4128:1024",
    "1:8": "704:5856",
    "8:1": "5856:704",
  },
  "4k": {
    "1:1": "4096:4096",
    "2:3": "3392:5056",
    "3:2": "5056:3392",
    "3:4": "3584:4800",
    "4:3": "4800:3584",
    "4:5": "3712:4608",
    "5:4": "4608:3712",
    "9:16": "3072:5504",
    "16:9": "5504:3072",
    "21:9": "6336:2688",
    "1:4": "2048:8256",
    "4:1": "8256:2048",
    "1:8": "1408:11712",
    "8:1": "11712:1408",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const SEEDREAM5_PRO_RATIOS = {
  "1k": {
    "1:1": "1024:1024",
    "4:3": "1184:896",
    "3:4": "896:1184",
    "16:9": "1376:768",
    "9:16": "768:1376",
    "3:2": "1296:864",
    "2:3": "864:1296",
  },
  "2k": {
    "1:1": "2048:2048",
    "4:3": "2304:1728",
    "3:4": "1728:2304",
    "16:9": "2720:1530",
    "9:16": "1530:2720",
    "3:2": "2496:1664",
    "2:3": "1664:2496",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const SEEDREAM5_LITE_RATIOS = {
  "2k": {
    "1:1": "2048:2048",
    "4:3": "2304:1728",
    "3:4": "1728:2304",
    "16:9": "2848:1600",
    "9:16": "1600:2848",
    "3:2": "2496:1664",
    "2:3": "1664:2496",
    "21:9": "3136:1344",
  },
  "3k": {
    "1:1": "3072:3072",
    "4:3": "3456:2592",
    "3:4": "2592:3456",
    "16:9": "4096:2304",
    "9:16": "2304:4096",
    "3:2": "3744:2496",
    "2:3": "2496:3744",
    "21:9": "4704:2016",
  },
  defaultTier: "2k",
  fallback: "2048:2048",
};

const SEEDREAM5_FLASH_RATIOS = {
  "1k": {
    "1:1": "1024:1024",
    "4:3": "1184:896",
    "3:4": "896:1184",
    "16:9": "1376:768",
    "9:16": "768:1376",
    "3:2": "1248:832",
    "2:3": "832:1248",
    "21:9": "1568:672",
  },
  "2k": {
    "1:1": "2048:2048",
    "4:3": "2304:1728",
    "3:4": "1728:2304",
    "16:9": "2848:1600",
    "9:16": "1600:2848",
    "3:2": "2496:1664",
    "2:3": "1664:2496",
    "21:9": "3136:1344",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const SEEDREAM5_5_RATIOS = {
  "1k": {
    "1:1": "1024:1024",
    "4:3": "1152:864",
    "3:4": "864:1152",
    "16:9": "1424:800",
    "9:16": "800:1424",
    "3:2": "1248:832",
    "2:3": "832:1248",
    "21:9": "1568:672",
  },
  "1.5k": {
    "1:1": "1536:1536",
    "4:3": "1792:1344",
    "3:4": "1344:1792",
    "16:9": "2048:1152",
    "9:16": "1152:2048",
    "3:2": "1872:1248",
    "2:3": "1248:1872",
    "21:9": "2352:1008",
  },
  "2k": {
    "1:1": "2048:2048",
    "4:3": "2368:1776",
    "3:4": "1776:2368",
    "16:9": "2816:1584",
    "9:16": "1584:2816",
    "3:2": "2496:1664",
    "2:3": "1664:2496",
    "21:9": "3136:1344",
  },
  defaultTier: "1k",
  fallback: "1024:1024",
};

const GEN4_VIDEO_I2V_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
    "4:3": "1104:832",
    "3:4": "832:1104",
    "1:1": "960:960",
    "21:9": "1584:672",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const GEN4_5_T2V_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const VEO_3_1_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
  },
  "1080p": {
    "16:9": "1920:1080",
    "9:16": "1080:1920",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const GEMINI_OMNI_FLASH_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const GEMINI_OMNI_FLASH_1_X_RATIOS = {
  "360p": { "16:9": "640:360", "9:16": "360:640" },
  "720p": { "16:9": "1280:720", "9:16": "720:1280" },
  "1080p": { "16:9": "1920:1080", "9:16": "1080:1920" },
  "4k": { "16:9": "3840:2160", "9:16": "2160:3840" },
  defaultTier: "720p",
  fallback: "1280:720",
};

const SEEDANCE_2_480_720_RATIOS = {
  "480p": {
    "21:9": "992:432",
    "16:9": "864:496",
    "4:3": "752:560",
    "1:1": "640:640",
    "3:4": "560:752",
    "9:16": "496:864",
  },
  "720p": {
    "21:9": "1470:630",
    "16:9": "1280:720",
    "4:3": "1112:834",
    "1:1": "960:960",
    "3:4": "834:1112",
    "9:16": "720:1280",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const SEEDANCE_2_FULL_RATIOS = {
  ...SEEDANCE_2_480_720_RATIOS,
  "1080p": {
    "21:9": "2206:946",
    "16:9": "1920:1080",
    "4:3": "1664:1248",
    "1:1": "1440:1440",
    "3:4": "1248:1664",
    "9:16": "1080:1920",
  },
  "4k": {
    "21:9": "3840:1646",
    "16:9": "3840:2160",
    "4:3": "3840:2880",
    "1:1": "3840:3840",
    "3:4": "2880:3840",
    "9:16": "2160:3840",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const SEEDANCE_2_5_480_720_RATIOS = {
  "480p": {
    "21:9": "992:432",
    "16:9": "854:480",
    "4:3": "752:560",
    "1:1": "640:640",
    "3:4": "560:752",
    "9:16": "480:854",
  },
  "720p": SEEDANCE_2_480_720_RATIOS["720p"],
  defaultTier: "720p",
  fallback: "1280:720",
};

const SEEDANCE_2_5_FULL_RATIOS = {
  ...SEEDANCE_2_5_480_720_RATIOS,
  "1080p": SEEDANCE_2_FULL_RATIOS["1080p"],
  "4k": SEEDANCE_2_FULL_RATIOS["4k"],
  defaultTier: "720p",
  fallback: "1280:720",
};

const KLING_720_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
    "1:1": "960:960",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const KLING_1080_RATIOS = {
  "1080p": {
    "16:9": "1920:1080",
    "9:16": "1080:1920",
    "1:1": "1440:1440",
  },
  defaultTier: "1080p",
  fallback: "1920:1080",
};

const KLING_4K_RATIOS = {
  "4k": {
    "16:9": "3840:2160",
    "9:16": "2160:3840",
    "1:1": "2880:2880",
  },
  defaultTier: "4k",
  fallback: "3840:2160",
};

const KLING_2_5_T2V_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
    "1:1": "720:720",
  },
  "1080p": {
    "16:9": "1920:1080",
    "9:16": "1080:1920",
    "1:1": "1440:1440",
  },
  defaultTier: "1080p",
  fallback: "1920:1080",
};

const KLING_4_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
    "1:1": "940:940",
    "21:9": "1460:624",
  },
  "1080p": {
    "16:9": "1920:1080",
    "9:16": "1080:1920",
    "1:1": "1440:1440",
    "21:9": "2200:940",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const KLING_4_FLASH_RATIOS = {
  "720p": {
    "16:9": "1280:720",
    "9:16": "720:1280",
    "1:1": "960:960",
    "21:9": "1464:628",
  },
  defaultTier: "720p",
  fallback: "1280:720",
};

const MODEL_RATIO_TABLES = {
  // Runway native
  gen4_image: GEN4_IMAGE_RATIOS,
  gen4_image_turbo: GEN4_IMAGE_RATIOS,
  "gen4.5": GEN4_VIDEO_I2V_RATIOS,
  gen4_turbo: GEN4_VIDEO_I2V_RATIOS,
  act_two: GEN4_VIDEO_I2V_RATIOS,
  // Google / Gemini image
  "gemini_image3.1_flash": GEMINI_IMAGE_3_1_FLASH_RATIOS,
  "gemini_image3.1_flash_lite": GEMINI_IMAGE_3_1_FLASH_LITE_RATIOS,
  gemini_image3_pro: GEMINI_IMAGE_3_PRO_RATIOS,
  "gemini_2.5_flash": GEMINI_2_5_FLASH_IMAGE_RATIOS,
  "nano_banana_2.1": NANO_BANANA_2_1_RATIOS,
  // Google / Gemini video
  "veo3.1": VEO_3_1_RATIOS,
  "veo3.1_fast": VEO_3_1_RATIOS,
  gemini_omni_flash: GEMINI_OMNI_FLASH_RATIOS,
  "gemini_omni_flash_1.1": GEMINI_OMNI_FLASH_1_X_RATIOS,
  "gemini_omni_flash_1.2": GEMINI_OMNI_FLASH_1_X_RATIOS,
  // ByteDance Seedream image
  seedream5_pro: SEEDREAM5_PRO_RATIOS,
  seedream5_lite: SEEDREAM5_LITE_RATIOS,
  seedream5_flash: SEEDREAM5_FLASH_RATIOS,
  "seedream5.5": SEEDREAM5_5_RATIOS,
  // ByteDance Seedance video
  seedance2: SEEDANCE_2_FULL_RATIOS,
  seedance2_fast: SEEDANCE_2_480_720_RATIOS,
  seedance2_mini: SEEDANCE_2_480_720_RATIOS,
  seedance2_5: SEEDANCE_2_5_FULL_RATIOS,
  seedance2_5_flash: SEEDANCE_2_5_480_720_RATIOS,
  // OpenAI GPT Image
  gpt_image_2: GPT_IMAGE_RATIOS,
  gpt_image_2_5_flare: GPT_IMAGE_RATIOS,
  gpt_image_2_5_sunburst: GPT_IMAGE_RATIOS,
  gpt_image_2_6_flare: GPT_IMAGE_RATIOS,
  gpt_image_2_6_sunburst: GPT_IMAGE_RATIOS,
  // Kling video
  kling_4: KLING_4_RATIOS,
  kling_4_flash: KLING_4_FLASH_RATIOS,
  "kling3.0_pro": KLING_1080_RATIOS,
  "kling3.0_standard": KLING_720_RATIOS,
  "kling3.0_4k": KLING_4K_RATIOS,
  klingO3_pro: KLING_1080_RATIOS,
  klingO3_standard: KLING_720_RATIOS,
  klingO3_4k: KLING_4K_RATIOS,
  "kling2.5_turbo_pro": KLING_2_5_T2V_RATIOS,
};

/**
 * Resolves a canonical aspectRatio + resolution pair into the exact Runway API
 * `ratio` string for the given (providerModelId, sdkMethod) combination.
 *
 * Returns `undefined` when the endpoint does not accept `ratio` (e.g.
 * `kling2.5_turbo_pro` on `imageToVideo` or `klingO3_*` on `videoToVideo`).
 *
 * @param {string} providerModelId
 * @param {string} sdkMethod
 * @param {string|undefined} aspectRatio
 * @param {string|undefined} resolution
 * @returns {string|undefined}
 */
export function resolveRunwayRatio(providerModelId, sdkMethod, aspectRatio, resolution) {
  // Endpoints that must NOT receive a `ratio` field
  if (
    providerModelId === "aleph2" ||
    providerModelId === "seedream5_pro_layers" ||
    providerModelId === "seedream5.5_layers" ||
    providerModelId === "magnific_precision_upscaler_v2" ||
    providerModelId === "magnific_video_upscaler_creative" ||
    providerModelId === "enhance_frame_rate"
  ) {
    return undefined;
  }

  if (providerModelId === "kling2.5_turbo_pro" && sdkMethod === "imageToVideo") {
    return undefined;
  }

  if (
    (providerModelId === "klingO3_pro" ||
      providerModelId === "klingO3_standard" ||
      providerModelId === "klingO3_4k" ||
      providerModelId === "gemini_omni_flash") &&
    sdkMethod === "videoToVideo"
  ) {
    return undefined;
  }

  // Kling 4 / Kling 4 Flash image-to-video only accepts auto_720p / auto_1080p
  if (providerModelId === "kling_4" && sdkMethod === "imageToVideo") {
    const tier = String(resolution || "720p").toLowerCase();
    return tier === "1080p" ? "auto_1080p" : "auto_720p";
  }
  if (providerModelId === "kling_4_flash" && sdkMethod === "imageToVideo") {
    return "auto_720p";
  }

  // Pass through already-formatted Runway auto or pixel ratios (e.g. "1280:720", "auto")
  if (typeof aspectRatio === "string") {
    const trimmed = aspectRatio.trim();
    if (AUTO_RATIO_RE.test(trimmed)) return trimmed.toLowerCase();
    if (EXACT_RATIO_RE.test(trimmed)) {
      const [w] = trimmed.split(":").map(Number);
      // Distinguish pixel ratios (e.g. "1280:720") from aspect ratios (e.g. "16:9")
      if (w >= 100) return trimmed;
    }
  }

  // Gen-4.5 textToVideo only supports 1280:720 and 720:1280
  const table =
    providerModelId === "gen4.5" && sdkMethod === "textToVideo"
      ? GEN4_5_T2V_RATIOS
      : MODEL_RATIO_TABLES[providerModelId];

  if (!table) return undefined;

  const tierKey = String(resolution || table.defaultTier || "").toLowerCase();
  const tierMap = table[tierKey] || table[table.defaultTier];
  if (!tierMap) return table.fallback;

  if (aspectRatio && tierMap[aspectRatio]) {
    return tierMap[aspectRatio];
  }

  // If aspectRatio exists in any other tier (e.g. caller picked 16:9 without matching tier), pick default tier's match
  return tierMap["16:9"] || tierMap["1:1"] || table.fallback;
}
