import "dotenv/config";
import "./src/container.js";
import { startGenerationWorker } from "#generation/tools";
import { startWalletWorker } from "#billing/tools";

export const worker = await startGenerationWorker();
export const walletWorker = await startWalletWorker();
export default worker;
