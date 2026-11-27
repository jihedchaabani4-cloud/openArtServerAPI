/**
 * @owns System 7: Elements
 * ElementAnalysisService.js
 * Standalone AI Vision Analysis & Taste Profile Service.
 * Handles element media retrieval, multimodal LLM vision inspection via central LLMService,
 * JSON schema extraction, and database persistence.
 */

import elementRepository from "../db/ElementRepository.js";
import { executeLLM } from "#models/tools";
import { getWorkflowVisualMedia } from "#media/tools";
import { createLogger } from "#shared";

const logger = createLogger("elements:analysis");

const KEYWORD_EXTRACTION_INSTRUCTION = `
CRITICAL OUTPUT REQUIREMENT:
You MUST format your entire response as a valid JSON object strictly matching this schema:
{
  "description": "A 3-5 sentence rich, technical Taste Profile description covering aesthetics, lighting, materials, and composition.",
  "keywords": ["5-10 concise, single/double-word factual visual identity keywords, e.g. oak wood, japanese minimal, pastel, warm lighting, matte finish"]
}
Do NOT include markdown formatting or extra commentary outside the JSON object.
`;

const ELEMENT_TYPE_PROMPTS = {
  character: `You are an elite AI Art Director specializing in character design and visual identity for high-end generative AI pipelines.
Your task: analyze the provided reference images and extract a precise, generative-AI-ready DNA profile and factual keywords for this Character element.
${KEYWORD_EXTRACTION_INSTRUCTION}`,

  object: `You are a senior Product Design Analyst and 3D Art Director specializing in extracting generative-AI-ready material and form profiles from reference imagery.
Your task: deconstruct the provided reference images into a precise DNA profile and factual keywords for this Object / Product element.
${KEYWORD_EXTRACTION_INSTRUCTION}`,

  style: `You are a Visual Language Specialist and Senior Creative Director who decodes aesthetic systems for generative AI pipelines.
Your task: analyze the provided reference images and extract a comprehensive, generative-AI-ready Style DNA profile and factual keywords.
${KEYWORD_EXTRACTION_INSTRUCTION}`,

  font: `You are a Type Director and Brand Identity Specialist with deep expertise in typography systems for both print and digital media.
Your task: analyze the provided reference images and extract a precise, generative-AI-ready typographic DNA profile and factual keywords.
${KEYWORD_EXTRACTION_INSTRUCTION}`,

  logo: `You are a Brand Identity Director and Visual Systems Strategist specializing in logo design and brand mark deconstruction for AI generation pipelines.
Your task: analyze the provided reference images and extract a precise, generative-AI-ready Brand Mark DNA profile and factual keywords.
${KEYWORD_EXTRACTION_INSTRUCTION}`,
};

const DEFAULT_TYPE_PROMPT = `You are an elite AI Art Director analyzing reference images to extract a generative-AI-ready visual DNA profile and factual keywords.
${KEYWORD_EXTRACTION_INSTRUCTION}`;


export class ElementAnalysisService {
  constructor({ workflowSync = null } = {}) {
    this.workflowSync = workflowSync;
  }
  /**
   * Main entry point: Analyzes reference images using Vision AI (via LLMService),
   * updates element description and keywords in Supabase DB, and returns metadata.
   */
  async analyzeElement({ projectId, workflowId, imageUrls = [], elementName, elementType, userId = null }) {
    const startTime = Date.now();

    logger.info({ projectId, workflowId, elementType, userId }, "Starting vision analysis via LLMService");

    // 1. Fetch images from DB if not provided in payload
    let resolvedUrls = Array.isArray(imageUrls) && imageUrls.length > 0 ? imageUrls : [];
    let resolvedMode = elementType || "object";

    if (resolvedUrls.length === 0 && (workflowId || projectId)) {
      const context = await this.fetchWorkflowContext(projectId, workflowId);
      resolvedUrls = context.urls;
      if (!elementType && context.elementType) {
        resolvedMode = context.elementType;
      }
    }

    if (resolvedUrls.length === 0) {
      throw new Error("ElementAnalysisService: No reference images found for this element.");
    }

    // 2. Perform Multimodal AI Vision LLM Analysis via LLMService
    const { description, keywords } = await this.runVisionLLMAnalysis(resolvedUrls, resolvedMode, userId);

    // 3. Directly update Supabase DB (workflow and element tables)
    if (workflowId) {
      await this.persistElementMetadata(workflowId, { description, keywords });
    }

    const durationMs = Date.now() - startTime;
    logger.info({
      workflowId,
      elementType: resolvedMode,
      durationMs,
      descriptionLength: description.length,
      keywordsCount: keywords.length,
    }, "Successfully analyzed and saved element metadata");

    return {
      success: true,
      description,
      keywords,
      workflowId,
      elementType: resolvedMode,
      durationMs,
    };
  }

  /**
   * Legacy wrapper for backward compatibility
   */
  async generateDescription({ elementName, elementType = "object", references = [], userId = null }) {
    const res = await this.analyzeElement({
      imageUrls: references,
      elementName,
      elementType,
      userId,
    });
    return res.description;
  }

  /**
   * Edit / Update Element Metadata in Database
   */
  async editElement(elementId, { name, description, keywords, guidelines, tags, element_type }) {
    logger.info({ elementId }, "Editing element");

    const patch = {};
    if (name !== undefined) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (keywords !== undefined) patch.keywords = keywords;
    if (guidelines !== undefined) patch.guidelines = guidelines;
    if (tags !== undefined) patch.tags = tags;
    if (element_type !== undefined) patch.element_type = element_type;

    // 1. Update element table
    let updatedElement = null;
    if (elementRepository?.update) {
      updatedElement = await elementRepository.update(elementId, patch);
    }

    // 2. Sync workflow metadata through injected workflowSync hook (owned by System 1: Generation)
    if (this.workflowSync?.findWorkflow && this.workflowSync?.updateWorkflow) {
      const wf = await this.workflowSync.findWorkflow(elementId);
      if (wf) {
        const updatedMeta = {
          ...(wf.metadata || {}),
          ...(description !== undefined ? { description } : {}),
          ...(keywords !== undefined ? { keywords } : {}),
          ...(guidelines !== undefined ? { guidelines } : {}),
          ...(name !== undefined ? { displayName: name } : {}),
          ...(element_type !== undefined ? { elementType: element_type } : {}),
        };

        const wfPatch = { metadata: updatedMeta };
        if (name !== undefined) wfPatch.display_name = name;
        if (element_type !== undefined) wfPatch.element_type = element_type;

        await this.workflowSync.updateWorkflow(wf.id, wfPatch);
      }
    }

    return {
      success: true,
      element: updatedElement || { id: elementId, ...patch },
    };
  }

  /**
   * Helper: Fetches reference media image URLs via #media/tools and workflow metadata via workflowSync
   */
  async fetchWorkflowContext(projectId, workflowId) {
    try {
      const urls = [];
      let elementType = "object";

      if (workflowId) {
        let wf = null;
        if (this.workflowSync?.findWorkflow) {
          try {
            wf = await this.workflowSync.findWorkflow(workflowId);
          } catch (_) {}
        }

        if (wf) {
          elementType = wf.element_type || wf.metadata?.elementType || "object";
        }

        const mediaItems = await getWorkflowVisualMedia(workflowId).catch(() => []);
        if (Array.isArray(mediaItems)) {
          for (const m of mediaItems) {
            const directUrl = m?.url || m?.file_url;
            if (directUrl) urls.push(directUrl);
          }
        }
      }

      return {
        urls: Array.from(new Set(urls)).filter(Boolean),
        elementType,
      };
    } catch (err) {
      logger.warn({ err: err.message }, "fetchWorkflowContext error");
      return { urls: [], elementType: "object" };
    }
  }

  /**
   * Delegates Vision LLM analysis to general LLMService
   */
  async runVisionLLMAnalysis(imageUrls, mode, userId = null) {
    const systemInstructions = ELEMENT_TYPE_PROMPTS[mode] || DEFAULT_TYPE_PROMPT;
    const promptText = "Analyze the attached reference images and return the requested JSON object matching the schema.";

    const result = await executeLLM({
      images: imageUrls,
      prompt: promptText,
      systemInstruction: systemInstructions,
      jsonMode: true,
      userId,
    });

    const parsed = result.json || {};
    const description = parsed.description || result.raw || "High quality visual reference element.";
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];

    return { description, keywords };
  }

  /**
   * Directly updates Supabase DB workflow & element table metadata
   */
  async persistElementMetadata(workflowId, { description }) {
    try {
      logger.info({ workflowId }, "Persisting metadata for workflow");

      // 1. Sync workflow metadata through injected workflowSync hook
      if (this.workflowSync?.findWorkflow && this.workflowSync?.updateWorkflow) {
        const wf = await this.workflowSync.findWorkflow(workflowId);
        if (wf) {
          const updatedMeta = {
            ...(wf.metadata || {}),
            description,
          };
          await this.workflowSync.updateWorkflow(wf.id, { metadata: updatedMeta });
          logger.info({ wfId: wf.id }, "Updated workflow metadata");
        }
      }

      // 2. Update element table
      if (elementRepository?.update) {
        const updatedElement = await elementRepository.update(workflowId, { description });
        logger.info({ workflowId, updatedId: updatedElement?.id || "Done" }, "Updated element table");
      }
    } catch (err) {
      logger.error({ err }, "DB persist error");
    }
  }
}

export default ElementAnalysisService;
