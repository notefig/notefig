import { z } from "zod";

export const FEEDBACK_WORKFLOW_ID = "feedback";

export const FEEDBACK_KINDS = ["bug", "idea", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_PLATFORMS = ["macos", "windows", "linux", "web"] as const;

export const FEEDBACK_MESSAGE_MIN = 10;
export const FEEDBACK_MESSAGE_MAX = 4000;

/**
 * What the app sends when someone submits feedback. Everything here ends
 * up public: the Linear issue it becomes syncs to the public GitHub repo.
 * `installId` is the exception — the service only keeps a salted hash of
 * it, to rate-limit and to recognise repeat submitters.
 */
export const feedbackSubmissionSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  message: z.string().trim().min(FEEDBACK_MESSAGE_MIN).max(FEEDBACK_MESSAGE_MAX),
  app: z.object({
    version: z.string().min(1).max(40),
    platform: z.enum(FEEDBACK_PLATFORMS),
  }),
  installId: z.string().uuid(),
});

export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;
