import type { KeySet } from "./jwt";
import { verifyJwt } from "./jwt";
import type { WorkflowStore } from "./store";

/**
 * Reading a private report: `GET /v1/reports/<workflow>/<report id>`, the
 * link on its Linear issue. Cloudflare Access guards the path; the Worker
 * checks Access's token on every request too, so a misconfigured or
 * missing Access application fails closed instead of opening reports to
 * everyone. With Access unconfigured the route answers 404.
 */

export const REPORT_ROUTE = /^\/v1\/reports\/([a-z0-9-]+)\/([0-9a-f-]+)$/;

export function reportPath(workflowId: string, reportId: string): string {
  return `/v1/reports/${workflowId}/${reportId}`;
}

export interface AccessConfig {
  /** e.g. notefig.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
  keys: KeySet;
}

export interface ReportDeps {
  access?: AccessConfig;
  store(workflowId: string): WorkflowStore | undefined;
  now(): number;
}

export async function readReport(
  deps: ReportDeps,
  accessToken: string | null,
  workflowId: string,
  reportId: string,
): Promise<Response> {
  if (!deps.access) return new Response("Not found", { status: 404 });
  const { teamDomain, audience, keys } = deps.access;
  const claims = accessToken
    ? await verifyJwt(accessToken, keys, { issuer: `https://${teamDomain}`, audience, now: deps.now })
    : undefined;
  if (!claims) return new Response("Sign in through Cloudflare Access", { status: 403 });

  const report = await deps.store(workflowId)?.report(reportId);
  if (!report) return new Response("This report was deleted, or never existed.", { status: 404 });
  return new Response(report.text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
