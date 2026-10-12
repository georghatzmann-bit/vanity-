import { create } from "zustand";
import { api } from "@/lib/api";
import type { UpdateInfo } from "@/lib/types";

interface UpdateState {
  info: UpdateInfo | null;
  checking: boolean;
  error: string | null;
  check: () => Promise<UpdateInfo | null>;
}

export const useUpdate = create<UpdateState>((set) => ({
  info: null,
  checking: false,
  error: null,
  check: async () => {
    set({ checking: true, error: null });
    try {
      const info = await api.updateCheck();
      set({ info, checking: false });
      return info;
    } catch (e) {
      set({ checking: false, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },
}));
