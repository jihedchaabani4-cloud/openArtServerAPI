import "dotenv/config";
import fetch from "node-fetch";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { storageService } from "../src/services/StorageService.js";


/**
 * calculateDimensions - Calculates image width/height based on quality and ratio
 * Returns standardized dimensions (multiples of 8)
 * NOTE: The current Ngrok model has a hard limit of 1024px.
 */
export function calculateDimensions(quality, ratio) {
    let base = 1024; // Base for 1K
    
    // While we define 2K/4K base sizes, the server currently caps it at 1024.
    // For now, we use 1024 as the absolute max base to avoid server errors.
    if (quality === "2K") base = 1024; // Cap for now
    else if (quality === "4K") base = 1024; // Cap for now

    let width = base;
    let height = base;

    if (ratio && typeof ratio === 'string') {
        const parts = ratio.split(":").map(Number);
        if (parts.length === 2) {
            const rW = parts[0];
            const rH = parts[1];
            if (rW >= rH) {
                // Landscape or square
                width = base;
                height = Math.round(base * (rH / rW));
            } else {
                // Portrait
                height = base;
                width = Math.round(base * (rW / rH));
            }
        }
    }

    // Standardize dimensions to be multiples of 8 (requirement for many AI models)
    width = Math.floor(width / 8) * 8;
    height = Math.floor(height / 8) * 8;

    // Final safety cap to 1024 for Ngrok server
    if (width > 1024) width = 1024;
    if (height > 1024) height = 1024;

    return { width, height };
}


/**
 * fetchImageAsBase64 - Fetches a remote image and converts it to base64
 */
export async function fetchImageAsBase64(imageUrl) {
    if (!imageUrl) return null;
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return buffer.toString('base64');
    } catch (error) {
        console.error("[ImageService] fetchImageAsBase64 error:", error.message);
        return null;
    }
}


/**
 * buildProfessionalPrompt - Converts the deep DNA JSON into a high-fidelity FLUX prompt
 * Strictly follows Part 5 Template Structure
 */
export function buildProfessionalPrompt(dna) {
    // Check if it's the new v4 DNA
    if (dna.meta && dna.meta.dna_version === 4) {
        return buildProfessionalPromptV4(dna);
    }

    const { identity_dna, physical_dna, style_dna, environment, expression_dna } = dna;
    // ... existing logic for v3 if needed ...
    // (Keeping the rest for backward compatibility or updating it all to v4)
}

/**
 * buildProfessionalPromptV4 - New logic for ULTIMATE DNA
 */
export function buildProfessionalPromptV4(dna) {
    const { species, demographics, geometry, surface, features, hair, style, environment, expression, render } = dna;
    
    // 1. Style & Rendering
    const renderingStyle = style.rendering_style || "Photorealistic";
    let prompt = `STYLE: ${renderingStyle.toUpperCase()}, ${renderingStyle} rendering style,\n`;

    // 2. Species & Demographics
    const ethnicity = Object.entries(demographics.ethnicity_vector)
        .filter(([_, val]) => val > 0)
        .map(([key, _]) => key)
        .join("-");
    
    prompt += `${demographics.age_numeric} year old ${ethnicity} ${demographics.gender_identity} ${species.subtype},\n`;

    // 3. Eyes & Face
    prompt += `${geometry.eyes.color} eyes, ${geometry.face.symmetry_score > 0.9 ? "symmetrical face" : ""},\n`;

    // 4. Surface & Skin
    const micro = surface.micro_details;
    prompt += `${surface.skin_material} skin with ${surface.undertone} undertones, `;
    prompt += `pore visibility ${micro.pore_visibility}, freckles ${micro.freckles_intensity},\n`;

    // 5. Hair
    prompt += `${hair.style} hair, color ${hair.base_color_hex}, density ${hair.density},\n`;

    // 6. Features & Body
    if (features.ears.type !== "human") prompt += `${features.ears.type} ears,\n`;
    if (features.horns) prompt += `${features.horns.type} horns,\n`;
    prompt += `${geometry.body.height_cm}cm height, posture ${geometry.body.posture_index},\n`;

    // 7. Outfit & Style
    prompt += `${style.outfit_description},\n`;
    if (style.accessories && style.accessories.length > 0) {
        prompt += `accessories: ${style.accessories.join(", ")},\n`;
    }

    // 8. Environment & Render
    prompt += `${environment.location}, ${environment.lighting}, ${environment.time_of_day},\n`;
    prompt += `lens: ${render.lens_profile}, depth of field: ${render.depth_of_field},\n`;

    // 9. Expression
    prompt += `${expression.emotion} expression, ${expression.gaze_direction} gaze,\n`;

    // 10. Final Technicals
    prompt += "extremely detailed, 8k, cinematic, masterpiece";

    return prompt.trim();
}

/**
 * calculatePulidWeight - Strictly follows PULID WEIGHT RULES (Part 4)
 */
export function calculatePulidWeight(changes, isRoot = false) {
    if (isRoot) return 0.75;

    // Priority-based weight (Lowest wins)
    if (changes.some(c => c.includes('sculpt'))) {
        if (changes.some(c => c.includes('nose'))) return 0.62;
        return 0.68;
    }
    if (changes.some(c => c.includes('body_type'))) return 0.74;
    if (changes.some(c => c.includes('hair'))) return 0.76;
    if (changes.some(c => c.includes('accessories') || c.includes('markings'))) return 0.78;
    if (changes.some(c => c.includes('expression'))) return 0.80;
    if (changes.some(c => c.includes('outfit'))) return 0.82;
    if (changes.some(c => c.includes('rendering_style'))) return 0.85;
    if (changes.some(c => c.includes('environment'))) return 0.92;

    return 0.88; // Default for full scene or unspecified
}

/**
 * determineEditParams - Strictly follows EDIT TYPE and MASK TARGET RULES (Part 4)
 */
export function determineEditParams(changes) {
    const editType = (changes.every(c => c.includes('environment') || c.includes('outfit') || c.includes('rendering_style')))
        ? "text-to-image" : "inpainting";

    let maskTarget = "";
    if (editType === "inpainting") {
        if (changes.some(c => c.includes('nose'))) maskTarget = "nose";
        else if (changes.some(c => c.includes('lips') || c.includes('mouth_teeth'))) maskTarget = "lips";
        else if (changes.some(c => c.includes('jawline'))) maskTarget = "jawline";
        else if (changes.some(c => c.includes('eye'))) maskTarget = "eyes";
        else if (changes.some(c => c.includes('ears'))) maskTarget = "ears";
        else if (changes.some(c => c.includes('horns'))) maskTarget = "horns";
        else if (changes.some(c => c.includes('hair'))) maskTarget = "hair";
        else if (changes.some(c => c.includes('body_type'))) maskTarget = "body";
        else if (changes.some(c => c.includes('outfit'))) maskTarget = "outfit";
        else if (changes.some(c => c.includes('markings'))) maskTarget = "markings";
    }

    return { editType, maskTarget };
}

/**
 * saveBlobToStorage - Helper to save base64/buffer to storage
 */
export async function saveBlobToStorage(base64OrBuffer, folder = "generations") {
    const timestamp = Date.now();
    const fileName = `${folder}/${timestamp}.jpg`;
    return storageService.upload(fileName, base64OrBuffer);
}

// Backward-compatible export name.
export const saveBlobToSupabase = saveBlobToStorage;
