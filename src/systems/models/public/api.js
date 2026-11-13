/**
 * System 2: Models Management — Public HTTP API Gateway (#models/api)
 *
 * Exposes model catalog presentation, schema introspection, pricing estimation,
 * and admin registry reload endpoints.
 *
 * Governed by:
 * - docs/architecture/constitution/01_business_systems_architecture.md (System 2)
 * - Rule 13: Express isolated strictly to public/api.js
 */

import { Router } from "express";
import {
  getCatalog,
  getModelSchema,
  getSchema,
  estimatePrice,
  reloadRegistry,
  getRegistryStats,
} from "./tools.js";

const router = Router();

export function formatModelDto(m) {
  return {
    key:            m.modelFamily || m.id,
    displayName:    m.displayName,
    description:    m.description || "",
    category:       m.domain,
    tier:           m.badge || "standard",
    pricing:        m.retailPricing || (m.operations && Object.values(m.operations)[0]?.retailPricing) || {},
    tags:           m.badge ? [m.badge.toLowerCase()] : [],
    icon:           m.iconUrl || "",
    badge:          m.badge || null,
    capabilities:   m.capabilities || {},
    parameters:     m.parameters || {},
  };
}

// ── GET / (Catalog Presentation) ─────────────────────────────────────────────
router.get("/", (req, res) => {
  const { category, domain } = req.query;
  const targetDomain = category || domain;

  const catalog = getCatalog(targetDomain ? { domain: targetDomain } : {});

  // Exclude system-only models from the public catalog
  const publicModels = catalog.filter((m) => !m.systemOnly && m.visibility !== "internal");
  const models = publicModels.map(formatModelDto);

  res.json({
    success: true,
    data: {
      total: models.length,
      models,
      grouped: models.reduce((acc, m) => {
        (acc[m.category] = acc[m.category] || []).push(m);
        return acc;
      }, {}),
    },
  });
});

// ── POST /admin/reload (Admin Registry & Pricing Reload) ──────────────────────
router.post("/admin/reload", (req, res) => {
  try {
    reloadRegistry();
    const stats = getRegistryStats();
    return res.json({
      success: true,
      message: "Model registry successfully reloaded",
      data: stats,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
      code: "REGISTRY_RELOAD_ERROR",
    });
  }
});

// ── GET /:key (Single Model Detail) ──────────────────────────────────────────
router.get("/:key", (req, res) => {
  const { key } = req.params;

  const catalog = getCatalog();
  const m = catalog.find((entry) => entry.modelFamily === key || entry.id === key);

  if (m) {
    return res.json({
      success: true,
      data: formatModelDto(m),
    });
  }

  return res.status(404).json({
    success: false,
    error: `Model "${key}" not found`,
    available: catalog.map((entry) => entry.modelFamily || entry.id),
  });
});

// ── GET /:key/schema (Canonical Parameter Schema) ───────────────────────────
router.get("/:key/schema", (req, res) => {
  const { key } = req.params;
  try {
    const schema = getModelSchema(key);
    return res.json({
      success: true,
      data: schema,
    });
  } catch (err) {
    return res.status(err.statusCode || 404).json({
      success: false,
      error: err.message,
      code: err.code || "SCHEMA_ERROR",
    });
  }
});

// ── POST /:key/estimate-price (Model-Level Price Estimation) ────────────────
router.post("/:key/estimate-price", (req, res) => {
  const { key } = req.params;
  try {
    const estimate = estimatePrice(key, req.body || {});
    return res.json({
      success: true,
      data: {
        credits: estimate.amount,
        amountString: estimate.amountString,
        currency: estimate.currency,
        pricingVersion: estimate.pricingVersion,
        planIdentity: estimate.planIdentity,
        breakdown: {
          basePrice: estimate.basePrice,
          modifiers: estimate.modifiersApplied,
        },
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      error: err.message,
      code: err.code || "PRICING_ESTIMATION_ERROR",
    });
  }
});

// ── GET /:key/:operation/schema (Legacy Compatibility - Deprecated) ──────────
router.get("/:key/:operation/schema", (req, res) => {
  const { key, operation } = req.params;
  res.setHeader("Deprecation", "true");
  res.setHeader(
    "Warning",
    `299 - "GET /api/models/:key/:operation/schema is deprecated. Use GET /api/models/:key/schema instead."`
  );
  try {
    const schema = getSchema(key, operation);
    return res.json({
      success: true,
      data: schema,
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      error: err.message,
      code: err.code || "SCHEMA_ERROR",
    });
  }
});

// ── POST /:key/:operation/estimate-price (Legacy Compatibility - Deprecated) ──
router.post("/:key/:operation/estimate-price", (req, res) => {
  const { key, operation } = req.params;
  res.setHeader("Deprecation", "true");
  res.setHeader(
    "Warning",
    `299 - "POST /api/models/:key/:operation/estimate-price is deprecated. Use POST /api/models/:key/estimate-price instead."`
  );
  try {
    const estimate = estimatePrice(key, req.body || {});
    return res.json({
      success: true,
      data: {
        credits: estimate.amount,
        amountString: estimate.amountString,
        currency: estimate.currency,
        pricingVersion: estimate.pricingVersion,
        planIdentity: estimate.planIdentity,
        breakdown: {
          basePrice: estimate.basePrice,
          modifiers: estimate.modifiersApplied,
        },
      },
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({
      success: false,
      error: err.message,
      code: err.code || "PRICING_ESTIMATION_ERROR",
    });
  }
});

export const modelsRouter = router;
export default router;
