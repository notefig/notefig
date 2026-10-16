import type { ZodType } from "zod";

/**
 * An intake workflow: something the public can submit that lands in Linear
 * Triage, and what accepting it there does. Feedback is the first; a new
 * one (crash reports, docs suggestions…) is another definition added to
 * `workflows/index.ts`. Each workflow's state lives in its own Durable
 * Object instance, named by `id`, so workflows never share keys.
 */
export interface Workflow {
  /** Permanent: names the submission path and the state object. */
  id: string;
  limits: WorkflowLimits;
  linear: WorkflowLinear;
  parse(body: unknown): ParseResult;
}

export interface WorkflowLimits {
  /** New issues per UTC day, across every submitter. */
  submissionsPerDay: number;
  /** Submissions per submitter per UTC day, duplicates included. */
  perSubmitterPerDay: number;
  /** Reports of an existing issue per UTC day (each comments on it). */
  duplicatesPerDay: number;
  /** Declined issues after which a submitter's submissions are dropped. */
  blockAfterDeclines: number;
  /**
   * Accepted issues per UTC day that start an agent build, so accepting a
   * batch can't queue more builds than meant. Builds you start yourself
   * (adding `agent:build`) aren't counted.
   */
  acceptedBuildsPerDay: number;
}

export interface WorkflowLinear {
  /** Marks an issue as this workflow's. Set at creation; never removed. */
  sourceLabel: string;
  /** What accepting the issue out of Triage does. */
  onAccept: {
    /** Adds `agent:build` and starts a build (builds.ts). */
    build: boolean;
    project?: string;
  };
  /** The title of the link to a submission's private report. */
  reportTitle?: string;
}

export type ParseResult =
  | { ok: true; submission: ParsedSubmission }
  | { ok: false; error: string };

export interface ParsedSubmission {
  /** Text that identifies a duplicate report (hashed before it's stored). */
  fingerprint: string;
  /** A stable anonymous id for the submitter (hashed before it's stored). */
  submitter?: string;
  issue(submissionId: string): IssueDraft;
  /** The comment left on the existing issue when someone reports it again. */
  duplicateComment: string;
  /**
   * Text kept out of the issue (it would sync to public GitHub): stored by
   * the service and linked from the issue behind Cloudflare Access.
   */
  report?: string;
}

export interface IssueDraft {
  title: string;
  description: string;
  /** Label names; the source label is added for you. */
  labels: string[];
}

interface WorkflowSpec<T> extends Omit<Workflow, "parse"> {
  schema: ZodType<T>;
  fingerprint(payload: T): string;
  submitter(payload: T): string | undefined;
  issue(payload: T, submissionId: string): IssueDraft;
  duplicateComment(payload: T): string;
  report?(payload: T): string | undefined;
}

/** Types a workflow against its schema, then erases the payload type. */
export function defineWorkflow<T>(spec: WorkflowSpec<T>): Workflow {
  return {
    id: spec.id,
    limits: spec.limits,
    linear: spec.linear,
    parse(body) {
      const parsed = spec.schema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid submission" };
      }
      const payload = parsed.data;
      return {
        ok: true,
        submission: {
          fingerprint: spec.fingerprint(payload),
          submitter: spec.submitter(payload),
          issue: (submissionId) => {
            const draft = spec.issue(payload, submissionId);
            return { ...draft, labels: [spec.linear.sourceLabel, ...draft.labels] };
          },
          duplicateComment: spec.duplicateComment(payload),
          report: spec.report?.(payload),
        },
      };
    },
  };
}

/**
 * User text going into a Linear issue, which syncs to public GitHub: quoted
 * so it reads as a report, with `@` defused so it can't mention anyone.
 */
export function quoteUserText(text: string): string {
  return defuseMentions(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function defuseMentions(text: string): string {
  return text.replace(/@/g, "@​");
}
