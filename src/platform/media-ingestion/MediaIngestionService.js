/**
 * MediaIngestionService
 * Platform Core Service for Media Ingestion.
 *
 * Implements: RAW SOURCE -> INGEST ONCE -> CANONICAL MEDIA -> USE MEDIA EVERYWHERE.
 *
 * Owns:
 * - Binary ingestion pipeline (reading, inspection, policy validation, transformation, storage upload)
 * - Safe platform-level media ingestion contracts
 *
 * Independent of domain services, workflow orchestration, and database records.
 *
 * Public methods:
 * - ingest(options)
 * - ingestBinary(options)
 */

import { BinaryIngestionService } from "./BinaryIngestionService.js";

export class MediaIngestionService {
    /**
     * @param {Object} [deps]
     * @param {Object} [deps.binaryIngestionService] - Pure BinaryIngestionService instance
     * @param {Object} [deps.storageService]         - StorageService instance
     */
    constructor({ binaryIngestionService = null, storageService = null } = {}) {
        this.binaryIngestionService = binaryIngestionService || (storageService ? new BinaryIngestionService({ storageService }) : null);
        this.storageService = storageService;
    }

    /**
     * Ingests binary/external source into storage:
     * Reads, inspects, validates, optimizes, and stores the media.
     * Pure platform method: does NOT create database records.
     *
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async ingestBinary(options) {
        if (!this.binaryIngestionService && this.storageService) {
            this.binaryIngestionService = new BinaryIngestionService({ storageService: this.storageService });
        }
        if (!this.binaryIngestionService) {
            throw new Error("BinaryIngestionService or StorageService is required for ingestBinary.");
        }
        return this.binaryIngestionService.ingestBinary(options);
    }

    /**
     * Platform-level media ingestion:
     * Executes binary ingestion and formats canonical metadata payload without DB side effects.
     *
     * @param {Object} options
     * @returns {Promise<Object>}
     */
    async ingest(options = {}) {
        const binaryResult = await this.ingestBinary(options);
        return {
            media: null,
            isNew: true,
            mediaId: null,
            workflowId: options.workflowId || null,
            ...binaryResult,
        };
    }
}

export default MediaIngestionService;
