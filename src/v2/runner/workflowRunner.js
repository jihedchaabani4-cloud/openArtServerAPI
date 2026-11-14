/**
 * Re-exports from #generation/tools.
 * Node failure handling in canonical implementation:
 * updateNodeRun(runId, nodeId, patch).catch((updateErr) => { workflowLogger.error(updateErr); })
 */
export {
    startWorkflowRun,
    executeOrchestration,
    PersistedBillingAccumulator,
    activeAccumulators,
    beginRunBillingAccumulator,
    endRunBillingAccumulator,
    getRunBillingAccumulator,
    initializeGateways,
    getGateways,
    isProviderBackedNodeType,
    getNodeBillingReference,
    estimateNodeBillingAmount,
    reserveNodeBilling,
    settleNodeBilling,
    rollbackNodeBilling,
    PROVIDER_BACKED_NODE_TYPES,
} from "#generation/tools";
