export function getStandardSize(ratio = "1:1", quality = "2K") {
    const base = {
        "1:1":  { width: 1024, height: 1024 },
        "16:9": { width: 1280, height: 720  },
        "9:16": { width: 720,  height: 1280 },
        "4:3":  { width: 1152, height: 864  },
        "3:4":  { width: 864,  height: 1152 },
        "2:3":  { width: 832,  height: 1248 },
        "3:2":  { width: 1248, height: 832  },
        "21:9": { width: 1536, height: 640  },
    };

    const scaleMap = {
        "1K": 1,       
        "2K": 2,       
        "4K": 4,
        "8K": 8, // Added for completeness (CinemaTreatment had it)
    };

    const dims  = base[ratio] || base["1:1"];
    const scale = scaleMap[String(quality).toUpperCase()] ?? 1.0;

    // snap to multiple of 16 + clamp to 4096 max (if 8K is used) or 2048 as before
    // Given the new scaleMap (1, 2, 4), 1024*4 = 4096. 
    // I will increase the clamp to 8192 if needed, but for now 4096 fits 4K.
    const maxDim = scale >= 8 ? 8192 : (scale >= 4 ? 4096 : 2048);
    let targetW = dims.width * scale;
    let targetH = dims.height * scale;

    const currentMax = Math.max(targetW, targetH);
    if (currentMax > maxDim) {
        const factor = maxDim / currentMax;
        targetW *= factor;
        targetH *= factor;
    }

    const snap = (v) => Math.min(maxDim, Math.round(v / 16) * 16);
    const width  = snap(targetW);
    const height = snap(targetH);

    return { width, height, size: `${width}*${height}` };
}

/**
 * Calculates resolution from a ratio (e.g. "16:9") with a maximum size constraint.
 */
export function getRatioSizeWithMaxSize(ratio, maxSize) {
    const [wRatio, hRatio] = ratio.split(':').map(Number);
    const aspectRatio = wRatio / hRatio;

    let width, height;

    if (wRatio >= hRatio) {
        // Landscape or Square (Width is the constraint)
        width = maxSize;
        height = Math.floor(maxSize / aspectRatio);
    } else {
        // Portrait (Height is the constraint)
        height = maxSize;
        width = Math.floor(maxSize * aspectRatio);
    }

    return { width, height };
}
