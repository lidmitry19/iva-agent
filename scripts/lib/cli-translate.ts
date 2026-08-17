// Two words in two languages for one CLI command, and the table that holds them lives in
// the authored tree (`agent/lib/i18n.ts`). `iva` has to run where that tree is missing
// (ADR-0003), and its help has to print anyway, so the table arrives through a lazy import
// and English is the answer until it does.
//
// The pair of literals at the call site is the repo idiom: no dictionaries, no keys.

/** English first, Russian second. */
export type Translate = (en: string, ru: string) => string;

export type LazyTranslate = {
  /** Stable reference: it reads whichever table is resolved at the moment of the call. */
  readonly tr: Translate;
  /** Load the table once, before the command prints anything. */
  readonly resolve: () => Promise<void>;
};

/**
 * The translator of one command group. A fixed one (tests, callers with their own table)
 * is used as it is and never replaced.
 */
export function createLazyTranslate(fixed?: Translate): LazyTranslate {
  let translate: Translate = fixed ?? ((en) => en);
  return {
    tr: (en, ru) => translate(en, ru),
    resolve: async () => {
      if (fixed) return;
      try {
        translate = (await import("#lib/i18n.ts")).tr;
      } catch {
        // agent/ is not built yet — English is not a reason to fail.
      }
    },
  };
}
