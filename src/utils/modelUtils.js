const ICONS = {
    nanobana:   "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/minimax.svg",
    google:     "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/google.svg",
    gpt:        "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
    seedream:   "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/baichuan.svg",
    seedance:   "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/baichuan.svg",
    zimage:     "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/zhipu.svg",
    kling:      "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/kling.svg",
    runway:     "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/runway.svg",
    wan:        "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/runway.svg",
    hailuo:     "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/minimax-color.svg",
    cinema:     "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/stability-color.svg",
    default:    "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/lobe.svg",
};

export const getModelMetadata = (modelName) => {
    if (!modelName) return { label: "Standard", iconUrl: ICONS.default };
    
    const name = modelName.toLowerCase();
    
    if (name.includes("cinema"))   return { label: "Cinema", iconUrl: ICONS.cinema };
    if (name.includes("nanobana")) return { label: "NanoBanana", iconUrl: ICONS.nanobana };
    if (name.includes("gpt-image") || name.includes("gpt_image") || name.includes("openai")) return { label: "GPT Image", iconUrl: ICONS.gpt };
    if (name.includes("google") || name.includes("veo") || name.includes("imagen")) return { label: "Google", iconUrl: ICONS.google };
    if (name.includes("seedream")) return { label: "SeaDream", iconUrl: ICONS.seedream };
    if (name.includes("seedance")) return { label: "Seedance", iconUrl: ICONS.seedance };
    if (name.includes("z-image") || name.includes("z_image"))  return { label: "Z-Image", iconUrl: ICONS.zimage };
    if (name.includes("kling"))    return { label: "Kling", iconUrl: ICONS.kling };
    if (name.includes("runway"))   return { label: "Runway", iconUrl: ICONS.runway };
    if (name.includes("wan"))      return { label: "Wan", iconUrl: ICONS.wan };
    if (name.includes("hailuo"))   return { label: "Hailuo", iconUrl: ICONS.hailuo };

    return { label: "Standard", iconUrl: ICONS.default };
};

export const MODEL_FAMILIES = [
  {
    id: "nano", name: "Nano Banana", type: "image",
    versions: [
      { id: "nanobana_2_0_google", name: "Nano Banana 2.0",    badge: "FAST",    subtext: "Gemini 2.0 efficiency",                featured: true  },
      { id: "nanobana_2_google",   name: "Nano Banana 2",      badge: "NEW",     subtext: "Pro-level intelligence",               featured: true  },
      { id: "nanobana_pro_google", name: "Nano Banana Pro",    badge: "PREMIUM", subtext: "State-of-the-art generation",          featured: true  },
      { id: "nanobana_2_5_google", name: "Nano Banana 2.5",    badge: "FAST",    subtext: "Standard Flash efficiency",            featured: true  },
    ],
  },
  {
    id: "imagen", name: "Imagen 4", type: "image",
    versions: [
      { id: "imagen_4",       name: "Imagen 4",       badge: "PRO",     subtext: "Superior text rendering",              featured: true  },
      { id: "imagen_4_ultra", name: "Imagen 4 Ultra", badge: "PREMIUM", subtext: "Highest detail generation",            featured: true  },
      { id: "imagen_4_fast",  name: "Imagen 4 Fast",  badge: "FAST",    subtext: "Quick high-quality output",            featured: false },
    ],
  },
  {
    id: "google_video", name: "Google Video", type: "video",
    versions: [
      { id: "veo_google",      name: "Google Veo 3.1",  badge: "PRO",     subtext: "Professional cinematic video",         featured: true  },
      { id: "nanobana_google", name: "Nano Banana Video", badge: "FAST",    subtext: "Fast Veo 3.1 Lite generation",         featured: false },
    ],
  },
  {
    id: "zimage", name: "Z-Image", type: "image",
    versions: [
      { id: "z-image-pro",      name: "Z-Image Pro",      badge: "PREMIUM", subtext: "State-of-the-art vision", featured: true  },
      { id: "z-image-pro-edit", name: "Z-Image Pro Edit", badge: "PREMIUM", subtext: "Pro-grade intelligent editing", featured: false },
      { id: "z-image-base",     name: "Z-Image Base",     badge: "PREMIUM", subtext: "High-quality model (CFG + Negative Prompt)", featured: false  },
      { id: "z-image-turbo",    name: "Z-Image Turbo",    badge: "FAST",    subtext: "Ultra-fast sub-second generation",  featured: true },
      { id: "z-image-edit",     name: "Z-Image Edit",     badge: "NEW",     subtext: "Intelligent image editing",  featured: false },
      { id: "z-image-normal",   name: "Z-Image",          badge: null,      subtext: "Standard vision model",    featured: false },
      { id: "z-image-lora",     name: "Z-Image LoRA",     badge: "PRO",     subtext: "Base model with LoRA support",    featured: false },
    ],
  },
  {
    id: "seedream", name: "SeaDream", type: "image",
    versions: [
      { id: "seedream",      name: "SeaDream 5.0 Lite",   badge: "NEW",     subtext: "Intelligent visual reasoning",              featured: true  },
      { id: "seedream_edit", name: "SeaDream 5.0 Edit",   badge: "PREMIUM", subtext: "ByteDance's advanced image editing",      featured: false },
    ],
  },

  {
    id: "stability", name: "Stable Diffusion", type: "image",
    versions: [],
  },
  {
    id: "kling", name: "Kling", type: "video",
    versions: [
      { id: "kling-3-pro",   name: "Kling 3 Pro",          badge: "EXCLUSIVE", quality: "4K",    dur: "5–20s", featured: true  },
      { id: "kling-3",       name: "Kling 3",              badge: "NEW",       quality: "1080p", dur: "3–15s", featured: false },
      { id: "kling-2.1-pro", name: "Kling 2.1 Pro",        badge: null,        quality: "1080p", dur: "5–10s", featured: false },
    ],
  },
  {
    id: "higgsfield", name: "Higgsfield", type: "video",
    versions: [
      { id: "higgsfield-soul-2",        name: "Higgsfield Soul 2.0",      badge: "NEW",     subtext: "Next generation ultra-realistic fashion visuals",  featured: true  },
      { id: "higgsfield-soul-cinema",   name: "Higgsfield Soul Cinema",   badge: "PREVIEW", subtext: "Cinematic-grade fashion visuals",                  featured: true  },
    ],
  },
  {
    id: "luma", name: "Luma AI", type: "video",
    versions: [
      { id: "luma-dream-machine", name: "Dream Machine 1.5", badge: "NEW", subtext: "High-fidelity cinematic motion", featured: true },
    ],
  },
  {
    id: "runway", name: "Runway", type: "video",
    versions: [
      { id: "runway-gen3", name: "Gen-3 Alpha", badge: "PREMIUM", subtext: "State-of-the-art video generation", featured: true },
    ],
  },
  {
    id: "kling-motion", name: "Kling Motion", type: "motion",
    versions: [
      { id: "kling_motion", name: "Motion Control v1", badge: "BETA", subtext: "Precise camera and subject control", featured: false },
    ],
  },
];
