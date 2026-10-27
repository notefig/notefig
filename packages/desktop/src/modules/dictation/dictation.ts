/**
 * Push-to-talk dictation as the app has it (`core.dictation`): the service
 * from `@notefig/dictation`, handed the browser microphone, the model the
 * app bundles (`public/dictation/`, scripts/fetch-dictation-model.mjs), the
 * user's setting and the platform's hold key, and started for the life of
 * the app. Editors attach through the Tiptap
 * extension in `@notefig/widgets`.
 */
import { toast } from "sonner";
import { defineModule } from "@notefig/core";
import {
  createDictation,
  createWorkerEngine,
  dictationHoldKey,
  openBrowserMicrophone,
  type DictationApi,
} from "@notefig/dictation";
import { kvModule } from "@/modules/kv";
import i18n from "@/utils/intl";

declare module "@notefig/core" {
  interface CoreModules {
    dictation: DictationApi;
  }
}

/**
 * The user's switch lives in the app settings namespace
 * (hooks/use-app-settings.ts), read here directly so this module doesn't
 * pull the React hook in. `dictationUsed` is this module's own: someone who
 * has dictated before gets the model loaded ahead of their next press.
 */
const SETTINGS = "settings";

export const dictationModule = defineModule({
  name: "dictation",
  needs: [kvModule],
  register: (ctx) => {
    const kv = ctx.use("kv");
    return createDictation({
      engine: createWorkerEngine(new URL(`${import.meta.env.BASE_URL}dictation/`, window.location.origin).href),
      openMicrophone: openBrowserMicrophone,
      enabled: async () => (await kv.read<boolean>(SETTINGS, "dictationEnabled")) ?? true,
      onDictated: () => void kv.write(SETTINGS, "dictationUsed", true),
      holdKey: dictationHoldKey(),
    });
  },
  boot: (dictation, ctx) => {
    const stopListening = dictation.listen();
    // A failed dictation inserts nothing, so say why (most often a refused
    // microphone permission).
    const stopReporting = dictation.subscribe(() => {
      const { status, error } = dictation.state();
      if (status === "error") toast.error(i18n.t("dictationFailed", { reason: error }));
    });
    // Warm once the app has settled, so it never competes with startup.
    const warming = setTimeout(async () => {
      const kv = ctx.use("kv");
      const used = await kv.read<boolean>(SETTINGS, "dictationUsed");
      const enabled = (await kv.read<boolean>(SETTINGS, "dictationEnabled")) ?? true;
      if (used && enabled) dictation.warm();
    }, 5_000);
    return () => {
      clearTimeout(warming);
      stopReporting();
      stopListening();
    };
  },
});
