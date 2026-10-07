import { useSyncExternalStore } from "react";
import { cartStore, type CartItem, type CartStore } from "./store";

const noopSubscribe = () => () => {};

export type UseCart = {
  items: readonly CartItem[];
  /** Sum of quantities (header badge). 0 on the server and until hydration. */
  count: number;
  /** False on the server and during hydration; true once the stored cart has been read. */
  ready: boolean;
  add: CartStore["add"];
  setQty: CartStore["setQty"];
  remove: CartStore["remove"];
  clear: CartStore["clear"];
};

/** The visitor's cart (client components only). Every tab and every component stays in sync. */
export function useCart(): UseCart {
  const snapshot = useSyncExternalStore(cartStore.subscribe, cartStore.getSnapshot, cartStore.getServerSnapshot);
  const ready = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return {
    items: snapshot.items,
    count: snapshot.count,
    ready,
    add: cartStore.add,
    setQty: cartStore.setQty,
    remove: cartStore.remove,
    clear: cartStore.clear,
  };
}
