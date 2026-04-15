import express from "express";
import * as elementController from "../controllers/elementController.js";

const router = express.Router();

/**
 * @route   GET /api/elements
 * @desc    List all elements with optional filters
 * @access  Public
 */
router.get("/", elementController.listElements);

/**
 * @route   GET /api/elements/:idOrSlug
 * @desc    Get a single element by ID or Slug
 * @access  Public
 */
router.get("/:idOrSlug", elementController.getElement);

/**
 * @route   POST /api/elements
 * @desc    Create a new element (character, location, prop)
 * @access  Public
 */
router.post("/", elementController.createElement);

/**
 * @route   PATCH /api/elements/:id
 * @desc    Update an existing element
 * @access  Public
 */
router.patch("/:id", elementController.updateElement);

/**
 * @route   DELETE /api/elements/:id
 * @desc    Delete an element
 * @access  Public
 */
router.delete("/:id", elementController.deleteElement);

export default router;
