import { z } from "zod";

export const FEEDBACK_WORKFLOW_ID = "feedback";

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_PLATFORMS = ["macos", "windows", "linux", "web"] as const;

export const FEEDBACK_MESSAGE_MIN = 10;
export const FEEDBACK_MESSAGE_MAX = 4000;
/** The longest debug report the service takes; the app trims to fit. */
export const DEBUG_REPORT_MAX = 200_000;

/**
 * What the app sends when someone submits feedback. The message ends up
 * public: the Linear issue it becomes syncs to the public GitHub repo.
 * Two fields never do:
 * - `installId`: the service keeps only a salted hash of it, to rate-limit
 *   and to recognise repeat submitters.
 * - `debugReport`: the debug panel's report, when the user chose to include
 *   it. The service keeps it out of the issue, behind a sign-in, and
 *   deletes it after 30 days.
 */
export const feedbackSubmissionSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  message: z.string().trim().min(FEEDBACK_MESSAGE_MIN).max(FEEDBACK_MESSAGE_MAX),
  app: z.object({
    // The app's package version. Kept to that shape because it's quoted
    // into the public issue unescaped.
    version: z
      .string()
      .max(40)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/),
    platform: z.enum(FEEDBACK_PLATFORMS),
  }),
  installId: z.string().uuid(),
  debugReport: z.string().max(DEBUG_REPORT_MAX).optional(),
});

export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;
