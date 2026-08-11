import "dotenv/config";
import { v2WorkflowWorker } from "../v2/queue/v2WorkflowWorker.js";

export { v2WorkflowWorker as worker };
export default v2WorkflowWorker;
