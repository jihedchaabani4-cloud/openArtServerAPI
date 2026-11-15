import { z } from "zod";

export const postRunRequestSchema = z.object({
  workflow_id: z.string({
    required_error: "workflow_id is required",
    invalid_type_error: "workflow_id must be a string",
  }).min(1, "workflow_id cannot be empty"),
  input: z.record(z.string(), z.any()),
});

export const runStatusResponseSchema = z.object({
  run_id: z.string().uuid(),
  workflow_id: z.string(),
  workflow_version: z.string(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  nodes: z.record(
    z.object({
      status: z.enum(["pending", "running", "completed", "failed"]),
      attempt: z.number(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
      error: z.object({
        code: z.string(),
        message: z.string(),
      }).nullable().optional(),
    })
  ),
  outputs: z.record(z.any()).nullable().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).nullable().optional(),
  created_at: z.string(),
  completed_at: z.string().nullable().optional(),
});
