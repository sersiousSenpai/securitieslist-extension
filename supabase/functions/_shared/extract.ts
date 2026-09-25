// Claude extracts the facts a firm release states. It never writes the
// user-facing summary: summaries are templated and attributed in code, so
// the model can't characterize allegations as findings.

import Anthropic from "npm:@anthropic-ai/sdk@0.128.0";
import { betaZodOutputFormat } from "npm:@anthropic-ai/sdk@0.128.0/helpers/beta/zod";
import { z } from "npm:zod@4.6.5";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the function's secrets

const DATE = z.string().nullable().describe("ISO date YYYY-MM-DD, or null if the release doesn't state it");

export const ReleaseFacts = z.object({
  kind: z
    .enum(["investigation", "lawsuit_filed", "other"])
    .describe("investigation: a firm announces it is investigating claims. lawsuit_filed: the release says a securities class action has been filed. other: anything else (settlements, non-securities matters)."),
  company_name: z.string().describe("The issuer's legal name as written, e.g. 'Fluence Energy, Inc.'"),
  alleged_conduct: z
    .string()
    .nullable()
    .describe("A short neutral phrase for what the release says may have been misrepresented, starting lowercase, max 15 words. Null if not stated."),
  class_period_start: DATE,
  class_period_end: DATE,
  lead_plaintiff_deadline: DATE,
  court: z.string().nullable().describe("Court where the suit was filed, abbreviated like 'S.D.N.Y.' or 'N.D. Cal.'; null if not stated"),
});
export type ReleaseFacts = z.infer<typeof ReleaseFacts>;

export async function extractReleaseFacts(title: string, body: string): Promise<ReleaseFacts | null> {
  const response = await client.beta.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ReleaseFacts) },
    system:
      "You extract facts from plaintiff law-firm press releases about securities claims. Report only what the release states; use null for anything it does not state. Do not infer dates.",
    messages: [{ role: "user", content: `<title>${title}</title>\n<release>\n${body}\n</release>` }],
  });
  if (response.stop_reason === "refusal") return null;
  return response.parsed_output ?? null;
}

export const EnforcementFacts = z.object({
  involves_listed_company: z
    .boolean()
    .describe("True only if the action names a company whose stock trades publicly on a U.S. exchange or OTC market, or names a current or former officer or director of such a company in that role."),
  company_name: z.string().nullable().describe("That listed company's name as written in the release; null if none."),
  ticker: z.string().nullable().describe("Its ticker if the release states it or you are certain of it; null otherwise."),
  named_party: z.enum(["company", "officer_or_director", "none"]).describe("Whether the company itself or one of its officers/directors is named."),
  alleged_conduct: z
    .string()
    .nullable()
    .describe("A short neutral phrase for what the SEC alleges, starting lowercase, max 15 words, e.g. 'overstating revenue in 2023 financial statements'. Null if unclear."),
  resolution: z.enum(["charged", "settled", "judgment", "other"]).describe("charged: complaint or proceedings instituted. settled: settled/consented without admitting or denying. judgment: court judgment or final order."),
});
export type EnforcementFacts = z.infer<typeof EnforcementFacts>;

// Either the release text (litigation releases are HTML) or the PDF bytes
// (administrative proceedings are published as PDFs, read natively).
export async function extractEnforcementFacts(title: string, source: { text: string } | { pdfBase64: string }) {
  const doc =
    "pdfBase64" in source
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: source.pdfBase64 } }
      : { type: "text" as const, text: `<release>\n${source.text}\n</release>` };
  const response = await client.beta.messages.parse({
    model: "claude-opus-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(EnforcementFacts) },
    system:
      "You read SEC enforcement releases and report whether they concern a publicly listed company or its officers. Most name individuals, private funds or advisers; those are not listed companies. Report only what the release states.",
    messages: [{ role: "user", content: [doc, { type: "text", text: `Release title: ${title}` }] }],
  });
  if (response.stop_reason === "refusal") return null;
  return response.parsed_output ?? null;
}
