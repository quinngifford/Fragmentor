import type { LoadPostingsInput, LoadPostingsOutput, LoadPostingsCaps } from "./contract.js";

/** Read the postings file and parse it into structured postings. */
export async function loadPostings(input: LoadPostingsInput, caps: LoadPostingsCaps): Promise<LoadPostingsOutput> {
  const text = await caps.files.readFile(input.path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${input.path} is not valid JSON.`);
  }

  if (!Array.isArray(parsed)) throw new Error(`${input.path} should hold a list of postings.`);

  return {
    postings: parsed.map((entry, i) => {
      const record = entry as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title : "";
      if (!title) throw new Error(`The posting at position ${i} has no title.`);
      return {
        title,
        company: typeof record.company === "string" ? record.company : "",
        description: typeof record.description === "string" ? record.description : "",
      };
    }),
  };
}
