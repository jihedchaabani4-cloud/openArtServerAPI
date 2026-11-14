import fetch from "node-fetch";
import { getDeepProperty } from "../mapping/parameterMapper.js";
import { ProviderTransientError } from "../errors/index.js";

/**
 * Server-Sent Events (SSE) Stream Reader
 * Normalizes streaming tokens across different provider SSE payloads.
 */
export async function readSseStream({ provider, binding, payload, credential, onChunk, customHeaders = {} }) {
  const baseUrl = provider.baseUrl.replace(/\/$/, "");
  const endpoint = binding.endpoint.startsWith("/") ? binding.endpoint : `/${binding.endpoint}`;
  const url = `${baseUrl}${endpoint}`;

  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...customHeaders,
  };

  if (credential) {
    if (provider.authType === "bearer") {
      headers[provider.authHeader || "Authorization"] = `Bearer ${credential}`;
    } else if (provider.authType === "header" || provider.authType === "apiKey") {
      headers[provider.authHeader || "X-API-Key"] = credential;
    }
  }

  // Force stream: true in payload
  const streamPayload = { ...payload, stream: true };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(streamPayload),
    });
  } catch (err) {
    throw new ProviderTransientError(`Stream connection failed to ${provider.id}: ${err.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Provider ${provider.id} stream rejected with HTTP ${response.status}: ${errorText}`
    );
  }

  const textDeltaField = binding.streamMapping?.textDeltaField || "choices[0].delta.content";
  let accumulatedText = "";

  return new Promise((resolve, reject) => {
    let buffer = "";

    response.body.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop(); // Keep partial line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue; // Comment or keepalive

        if (trimmed === "data: [DONE]" || trimmed === "data:[DONE]") {
          if (typeof onChunk === "function") {
            onChunk({ textDelta: "", isFinished: true });
          }
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            const delta = getDeepProperty(data, textDeltaField);
            if (delta) {
              accumulatedText += delta;
              if (typeof onChunk === "function") {
                onChunk({ textDelta: delta, isFinished: false });
              }
            }
          } catch {
            // Ignore non-json data line
          }
        }
      }
    });

    response.body.on("end", () => {
      if (typeof onChunk === "function") {
        onChunk({ textDelta: "", isFinished: true });
      }
      resolve({ text: accumulatedText, streamed: true });
    });

    response.body.on("error", (err) => {
      reject(new ProviderTransientError(`Stream aborted unexpectedly: ${err.message}`));
    });
  });
}
