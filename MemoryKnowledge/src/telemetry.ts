/**
 * OpenTelemetry + Langfuse span processor initialization.
 *
 * initTelemetry() is called at the very top of server.ts to ensure the OTel SDK
 * is registered before any module loads. Silently skipped when LANGFUSE_SECRET_KEY is unset; does not affect the service.
 *
 * The AI SDK's generateText({ experimental_telemetry: { isEnabled: true } })
 * automatically emits GEN_AI semantic-convention spans; LangfuseSpanProcessor batches and exports them to Langfuse.
 */

// .env must be loaded before reading process.env,
// because initTelemetry() runs before config.ts (which contains import 'dotenv/config')
import 'dotenv/config';

import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { trace, type Span } from "@opentelemetry/api";
import { createLogger } from "./logger.js";

const log = createLogger("telemetry");

let sdk: NodeSDK | null = null;

/** Initialize OpenTelemetry + Langfuse. Silently skipped when no key is configured. */
export function initTelemetry(): void {
  if (sdk) return; // prevent double initialization

  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!secretKey) {
    log.info("Langfuse telemetry disabled (LANGFUSE_SECRET_KEY not set)");
    return;
  }

  try {
    sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          shouldExportSpan: () => true,
        }),
      ],
    });
    sdk.start();
    log.info("Langfuse telemetry initialized", {
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    });
  } catch (err) {
    log.warn("Langfuse telemetry init failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    sdk = null;
  }

  // Flush remaining spans on graceful shutdown
  process.on("SIGTERM", () => {
    sdk?.shutdown().catch(() => {});
  });
}

// ── Tracing helpers ──

/** Shared tracer used by the ingest flow to create parent spans. */
export const tracer = trace.getTracer("knowledge-wiki");

/**
 * Run an async function within a span context. The AI SDK's experimental_telemetry automatically
 * nests generateText spans as children of the current active span.
 *
 * Usage:
 *   const result = await withSpan("wiki-ingest", async (span) => {
 *     span.setAttribute("wiki.name", name);
 *     return runIngest(...);
 *   });
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    // The langfuse.name attribute makes the Langfuse UI display the trace title
    span.setAttribute("langfuse.name", name);
    try {
      return await fn(span);
    } finally {
      span.end();
    }
  });
}
