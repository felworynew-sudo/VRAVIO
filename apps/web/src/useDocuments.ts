import { useSyncExternalStore } from "react";
import { kernel } from "./kernel";

function subscribe(listener: () => void): () => void {
  const subscription = kernel.documents.subscribe(listener);
  return () => subscription.dispose();
}

export function useDocuments() {
  useSyncExternalStore(subscribe, () => kernel.documents.getVersion(), () => kernel.documents.getVersion());
  return kernel.documents.list();
}
