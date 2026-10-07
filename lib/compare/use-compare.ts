import { useSyncExternalStore } from "react";
import { COMPARE_MAX, compareStore, type CompareIds, type CompareStore } from "./store";

const noopSubscribe = () => () => {};

export type UseCompare = {
  /** Selected product slugs, in order (empty on the server and until hydration). */
  ids: CompareIds;
  /** False on the server and during hydration. */
  ready: boolean;
  toggle: CompareStore["toggle"];
  remove: CompareStore["remove"];
  replace: CompareStore["replace"];
  clear: CompareStore["clear"];
  MAX: typeof COMPARE_MAX;
};

/** The compare selection (client components only); shared by the catalog tray and the compare page, across tabs. */
export function useCompare(): UseCompare {
  const ids = useSyncExternalStore(compareStore.subscribe, compareStore.getSnapshot, compareStore.getServerSnapshot);
  const ready = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return {
    ids,
    ready,
    toggle: compareStore.toggle,
    remove: compareStore.remove,
    replace: compareStore.replace,
    clear: compareStore.clear,
    MAX: COMPARE_MAX,
  };
}
