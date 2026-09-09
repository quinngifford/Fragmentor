import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod/v4";

/**
 * The seam between Fragmentor and the model.
 *
 * It exists so the decomposition loop can be driven by a scripted stand-in in
 * tests. Everything interesting about decomposition — validating a proposal
 * and feeding the problems back — is deterministic, and only this interface
 * stands between that logic and a real network call.
 */
export interface ModelTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  system: string;
  messages: ModelTurn[];
  /** When supplied, the model is constrained to produce JSON matching it. */
  schema?: z.ZodType<unknown>;
}

export interface ModelClient {
  /** Returns the model's response as text. With a schema, that text is JSON. */
  complete(request: ModelRequest): Promise<string>;
}

export const DECOMPOSITION_MODEL = "claude-opus-5";

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(private readonly model: string = DECOMPOSITION_MODEL, client?: Anthropic) {
    // With no explicit key the SDK resolves ANTHROPIC_API_KEY, then
    // ANTHROPIC_AUTH_TOKEN, then a stored `ant auth login` profile.
    this.client = client ?? new Anthropic();
  }

  async complete(request: ModelRequest): Promise<string> {
    const common = {
      model: this.model,
      max_tokens: 16000,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      // Deciding how to carve up a system is judgment work, so let the model
      // think about it properly.
      thinking: { type: "adaptive" as const },
      output_config: { effort: "high" as const },
    };

    if (request.schema) {
      const response = await this.client.messages.parse({
        ...common,
        output_config: { ...common.output_config, format: zodOutputFormat(request.schema) },
      });

      if (response.stop_reason === "refusal") {
        throw new Error(`The model declined to answer: ${response.stop_details?.explanation ?? "no explanation"}`);
      }
      if (response.parsed_output === null || response.parsed_output === undefined) {
        throw new Error("The model returned output that did not match the expected shape.");
      }
      return JSON.stringify(response.parsed_output);
    }

    const response = await this.client.messages.create(common);
    if (response.stop_reason === "refusal") {
      throw new Error(`The model declined to answer: ${response.stop_details?.explanation ?? "no explanation"}`);
    }

    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
}

/**
 * Replays canned responses in order. Used by tests to drive the decomposition
 * loop, including its retry behaviour, without a network call.
 */
export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly responses: string[]) {}

  async complete(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    const response = this.responses[this.index];
    if (response === undefined) {
      throw new Error(`The scripted model client ran out of responses after ${this.index}.`);
    }
    this.index += 1;
    return response;
  }
}
