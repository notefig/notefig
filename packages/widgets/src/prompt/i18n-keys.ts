/**
 * Every translation key this package's UI resolves at runtime.
 *
 * The strings themselves deliberately stay in the host application's
 * resource table — one place to translate, one place to review copy. The
 * cost of that choice is a dependency the type system cannot see: the widget
 * calls `t("promptBlobDone")` and simply trusts the app to have defined it.
 * A missing key doesn't throw; i18next renders the key name, so the failure
 * mode is a button labelled "promptBlobDone" shipping to a user.
 *
 * This list closes that hole. The app asserts every key resolves — see
 * prompt-widget-i18n.test.ts in the desktop package — which turns a silent
 * rendering bug into a failing test the moment either side drifts.
 *
 * Keep it in sync when adding or removing a `t()` call; the app's test is
 * what tells you if you forget the other half.
 */
export const PROMPT_WIDGET_I18N_KEYS = [
  "agentChooseHarness",
  "agentRemoveFromQueue",
  "agentSignInRequired",
  "agentStop",
  "copied",
  "copy",
  "copyMessage",
  "mentionFilesLabel",
  "promptBlobDismiss",
  "promptBlobDone",
  "promptBlobEdit",
  "promptBlobFailed",
  "promptBlobIssue",
  "promptBlobNewSession",
  "promptBlobOpenChat",
  "promptBlobPlaceholder",
  "promptBlobQueued",
  "promptBlobQueuedAhead",
  "promptBlobReply",
  "promptBlobRetry",
  "promptBlobSessionGone",
  "promptBlobShowLess",
  "promptBlobShowMore",
  "promptBlobStopped",
  "promptBlobTrustWarning",
] as const;
