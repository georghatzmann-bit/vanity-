/*
 * Build downloader – the UI side: the list of downloads, the events from Rust, and small helpers
 * for sizes and times.
 *
 * Rust (src-tauri/src/download) does the work: the file list comes from the public GitHub archive
 * (pinned by SHA-1), every game byte comes from Epic's own servers. The UI only starts, pauses,
 * resumes and cancels, and shows what the events say.
 *
 * In the browser preview a small stand-in plays a download (sped up), so every screen can be
 * looked at: ?page=download&dl=running|paused|error|chunks|verifying|ready and &season=2-5.
 */
import { create } from "zustand";
import { toast } from "sonner";
import {
  api,
  errorText,
  inTauri,
  onEvent,
  type BuildInfo,
  type Catalog,
  type CatalogBuild,
  type DownloadError,
  type DownloadJob,
  type DownloadPhase,
  type DownloadProgress,
  type DownloadState,
  type Profile,
} from "./api";
import { classicMatch, demoCatalog } from "./demo-data";
import { previewParam, useApp } from "./store";

// ---- Texts -------------------------------------------------------------------------------------

/** The four steps of a download, in order (same as the `phase` values). */
export const downloadSteps: { phase: DownloadPhase; label: string; hint: string; doing: string; badge: string }[] = [
  { phase: "checking", label: "Check at Epic", hint: "a few minutes", doing: "Checking that Epic still has every file… (a few minutes)", badge: "Checking" },
  { phase: "downloading", label: "Download", hint: "from Epic's servers", doing: "Downloading from Epic's servers", badge: "Downloading" },
  { phase: "verifying", label: "Check files", hint: "nothing is missing", doing: "Checking files", badge: "Checking files" },
  { phase: "importing", label: "Add to Library", hint: "ready to play", doing: "Adding to Library", badge: "Adding" },
];

export function phaseIndex(phase: DownloadPhase): number {
  return Math.max(0, downloadSteps.findIndex((s) => s.phase === phase));
}

/** Short title for each error code (the message itself comes from Rust and is shown as it is). */
const errorTitles: Record<string, string> = {
  MANIFEST_UNAVAILABLE: "Couldn't get the file list",
  MANIFEST_MISMATCH: "Unexpected file list",
  CHUNKS_MISSING: "Epic no longer has every file",
  EPIC_BLOCKED: "Epic refused the download",
  NETWORK: "The connection dropped",
  NOT_ENOUGH_SPACE: "Not enough free space",
  FAT32: "This drive can't hold big files",
  ONEDRIVE: "This folder is synced by OneDrive",
  NOT_EMPTY: "This folder isn't empty",
  WRITE_FAILED: "Can't write to this folder",
  VERIFY_FAILED: "A file was damaged",
  IMPORT_FAILED: "Couldn't add it to the Library",
  NETWORK_DRIVE: "This folder is on a network drive",
  PATH_TOO_LONG: "This folder's path is too long",
  OWN_FOLDER: "This is Niobium's own folder",
  ALREADY_RUNNING: "Already downloading",
  ANOTHER_RUNNING: "Another download is running",
  UNKNOWN_BUILD: "Can't download this version",
};

export function errorTitle(code: string): string {
  return errorTitles[code] ?? "The download stopped";
}

/** What the error card offers: try again (Resume), pick another folder, or nothing to retry. */
export type ErrorFix = "resume" | "retry" | "folder" | "none" | "import";

/** `filesKept`: files of the build are in the folder already (the error came in the middle). */
export function errorFix(code: string, filesKept = false): ErrorFix {
  // A write error in the middle of a download (full disk, a program locking a file): Resume fixes it
  if (code === "WRITE_FAILED" && filesKept) return "resume";
  switch (code) {
    case "NETWORK":
      return "resume";
    case "MANIFEST_UNAVAILABLE":
    case "EPIC_BLOCKED":
    case "VERIFY_FAILED":
      return "retry";
    case "NOT_ENOUGH_SPACE":
    case "FAT32":
    case "ONEDRIVE":
    case "NOT_EMPTY":
    case "WRITE_FAILED":
    case "NETWORK_DRIVE":
    case "PATH_TOO_LONG":
    case "OWN_FOLDER":
      return "folder";
    case "CHUNKS_MISSING":
    case "MANIFEST_MISMATCH":
    case "UNKNOWN_BUILD":
      return "none";
    case "IMPORT_FAILED":
      return "import";
    default:
      return "retry";
  }
}

// ---- Sizes and times ---------------------------------------------------------------------------

/** Same as Rust's `gb()`: "45.4 GB" (decimal gigabytes). */
export function formatGB(bytes: number): string {
  return `${(Math.max(0, bytes) / 1e9).toFixed(1)} GB`;
}

export function formatSpeed(bps: number): string {
  if (bps <= 0) return "–";
  if (bps < 1e6) return `${Math.round(bps / 1e3)} KB/s`;
  return `${(bps / 1e6).toFixed(1)} MB/s`;
}

/** "about 1 h 50 min", "about 40 min", "less than a minute". */
export function formatDuration(secs: number, about = false): string {
  if (!Number.isFinite(secs) || secs < 0) return "–";
  if (secs < 60) return "less than a minute";
  const prefix = about ? "about " : "";
  const totalMin = Math.round(secs / 60);
  if (totalMin < 60) return `${prefix}${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${prefix}${h} h` : `${prefix}${h} h ${m} min`;
}

/** Rough download time at 50 Mbit/s, rounded to 10 minutes: "about 1 h 50 min". */
export function roughTimeAt50Mbit(bytes: number): string {
  const secs = (bytes * 8) / 50e6;
  const rounded = Math.max(10, Math.round(secs / 600) * 10) * 60;
  return formatDuration(rounded, true);
}

/** Space the folder needs: the build on disk plus 2 GiB to spare (same as Rust's `space_needed`). */
export function spaceNeeded(installedBytes: number): number {
  return installedBytes + 2 * 1024 ** 3;
}

/** 0 … 1 for the current phase. */
export function phaseFraction(p: DownloadProgress): number {
  if (p.bytesTotal > 0) return Math.min(1, p.bytesDone / p.bytesTotal);
  if (p.filesTotal > 0) return Math.min(1, p.filesDone / p.filesTotal);
  return 0;
}

// ---- State -------------------------------------------------------------------------------------

/** A download as the UI shows it. `pending` = a button was pressed and Rust hasn't confirmed yet. */
export interface DownloadJobView extends DownloadJob {
  pending: "pausing" | "resuming" | "cancelling" | null;
}

interface DownloadsState {
  catalog: Catalog | null;
  catalogError: string | null;
  jobs: DownloadJobView[];
  loadCatalog: () => Promise<void>;
  /** Starts a download. Returns the reason when Rust refused it (shown under the folder field). */
  start: (build: CatalogBuild, folder: string) => Promise<DownloadError | null>;
  pause: (key: string) => Promise<void>;
  resume: (key: string) => Promise<void>;
  cancel: (key: string, deleteFiles: boolean) => Promise<void>;
  /** Forgets a finished download (the build stays in the Library). */
  dismiss: (key: string) => Promise<void>;
}

const emptyProgress = (key: string, phase: DownloadPhase = "checking"): DownloadProgress => ({
  key,
  phase,
  bytesDone: 0,
  bytesTotal: 0,
  filesDone: 0,
  filesTotal: 0,
  speedBps: 0,
  etaSecs: null,
  currentFile: "",
});

export const useDownloads = create<DownloadsState>()((set, get) => ({
  catalog: null,
  catalogError: null,
  jobs: [],

  loadCatalog: async () => {
    if (get().catalog) return;
    try {
      set({ catalog: await api.catalogList(), catalogError: null });
    } catch (e) {
      set({ catalogError: errorText(e) });
    }
  },

  start: async (build, folder) => {
    try {
      if (inTauri) await api.downloadStart(build.key, folder);
      else demo.start(build, folder);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) return e as DownloadError;
      return { code: "", message: errorText(e) };
    }
    upsert({
      key: build.key,
      version: build.version,
      cl: build.cl,
      folder,
      state: "running",
      progress: emptyProgress(build.key),
      error: null,
      buildId: null,
      filesKept: false,
      pending: null,
    });
    return null;
  },

  pause: async (key) => {
    patch(key, { pending: "pausing" });
    try {
      if (inTauri) await api.downloadPause(key);
      else demo.pause(key);
    } catch (e) {
      patch(key, { pending: null });
      toast.error("Couldn't pause", { description: errorText(e) });
    }
  },

  resume: async (key) => {
    patch(key, { pending: "resuming" });
    try {
      if (inTauri) await api.downloadResume(key);
      else demo.resume(key);
      patch(key, { state: "running", error: null, pending: null });
    } catch (e) {
      patch(key, { pending: null });
      toast.error("Couldn't continue", { description: errorText(e) });
    }
  },

  cancel: async (key, deleteFiles) => {
    const running = get().jobs.find((j) => j.key === key)?.state === "running";
    patch(key, { pending: "cancelling" });
    try {
      if (inTauri) await api.downloadCancel(key, deleteFiles);
      else demo.cancel(key, deleteFiles);
      // A running download stops within seconds and then sends "cancelled"; anything else is gone now
      if (!running) remove(key);
    } catch (e) {
      patch(key, { pending: null });
      toast.error("Couldn't cancel", { description: errorText(e) });
    }
  },

  dismiss: async (key) => {
    remove(key);
    try {
      if (inTauri) await api.downloadCancel(key, false);
    } catch {
      /* already gone */
    }
  },
}));

function upsert(job: DownloadJobView) {
  useDownloads.setState((s) => {
    const i = s.jobs.findIndex((j) => j.key === job.key);
    if (i < 0) return { jobs: [job, ...s.jobs] };
    const jobs = s.jobs.slice();
    jobs[i] = job;
    return { jobs };
  });
}

function patch(key: string, change: Partial<DownloadJobView>): boolean {
  let found = false;
  useDownloads.setState((s) => ({
    jobs: s.jobs.map((j) => {
      if (j.key !== key) return j;
      found = true;
      return { ...j, ...change };
    }),
  }));
  return found;
}

function remove(key: string) {
  useDownloads.setState((s) => ({ jobs: s.jobs.filter((j) => j.key !== key) }));
}

/** An event for a download the UI doesn't know yet (e.g. started before a reload): fetch the list. */
async function refreshJobs() {
  if (!inTauri) return;
  try {
    const jobs = await api.downloadStatus();
    useDownloads.setState((s) => ({
      jobs: jobs.map((j) => ({ ...j, pending: s.jobs.find((x) => x.key === j.key)?.pending ?? null })),
    }));
  } catch {
    /* keep what we have */
  }
}

// ---- Events (Rust, or the preview stand-in) ----------------------------------------------------

function onProgress(p: DownloadProgress) {
  if (!patch(p.key, { progress: p })) void refreshJobs();
}

function onState({ key, state }: { key: string; state: DownloadState }) {
  if (state === "cancelled") {
    remove(key);
    return;
  }
  const change: Partial<DownloadJobView> = { state, pending: null };
  if (state === "running") change.error = null;
  if (!patch(key, change)) void refreshJobs();
}

function onError({ key, code, message, filesKept }: { key: string; filesKept?: boolean } & DownloadError) {
  if (!patch(key, { state: "error", error: { code, message }, filesKept: filesKept ?? false, pending: null })) void refreshJobs();
}

function onDone({ key, buildId }: { key: string; buildId: string }) {
  patch(key, { state: "done", buildId, pending: null });
  // The new build is in the config now (Rust also shows the "… is ready. Press Play." toast)
  void useApp.getState().reload().catch(() => {});
}

let started = false;

/** Loads the list of downloads (unfinished ones from last time come back as "paused") and listens. */
export function initDownloads() {
  if (started) return;
  started = true;
  if (inTauri) {
    onEvent<DownloadProgress>("download:progress", onProgress);
    onEvent<{ key: string; state: DownloadState }>("download:state", onState);
    onEvent<{ key: string; filesKept?: boolean } & DownloadError>("download:error", onError);
    onEvent<{ key: string; buildId: string }>("download:done", onDone);
    void refreshJobs();
  } else {
    demo.seed(previewParam("dl"));
  }
}

// ---- Helpers for the pages ---------------------------------------------------------------------

/** The download to show first: the running one, then stopped ones, then finished ones. */
export function mainJob(jobs: DownloadJobView[]): DownloadJobView | null {
  const order: DownloadState[] = ["running", "error", "paused", "done"];
  for (const st of order) {
    const j = jobs.find((x) => x.state === st);
    if (j) return j;
  }
  return null;
}

/** All builds of the catalog, flat. */
export function catalogBuilds(catalog: Catalog | null): CatalogBuild[] {
  return catalog?.chapters.flatMap((c) => c.seasons.flatMap((s) => s.builds)) ?? [];
}

/** "Chapter 2 · Season 5" for a build key (from the catalog). */
export function seasonLabelOf(catalog: Catalog | null, key: string): string {
  for (const c of catalog?.chapters ?? []) {
    for (const s of c.seasons) {
      if (s.builds.some((b) => b.key === key)) return `${c.label} · ${s.label}`;
    }
  }
  return "";
}

/**
 * "Play" on a finished download: makes a profile for the new build the active one (an existing
 * profile with that build, or a new "Classic match" profile) and goes to Home.
 */
export async function playDownloadedBuild(job: DownloadJobView): Promise<void> {
  const app = useApp.getState();
  try {
    await app.reload();
  } catch {
    /* use what we have */
  }
  const config = useApp.getState().config;
  const build =
    config.builds.find((b) => b.id === job.buildId) ?? config.builds.find((b) => b.version === job.version && b.changelist === job.cl);
  if (!build) {
    toast.error("Couldn't find the build", { description: "Add it in the Library with 'Add a build'." });
    return;
  }
  let profile =
    config.profiles.find((p) => p.id === config.activeProfileId && p.buildId === build.id) ??
    config.profiles.find((p) => p.buildId === build.id);
  try {
    if (!profile) {
      const p: Profile = {
        id: `p-${Date.now()}`,
        name: `Fortnite ${build.version}`,
        description: "A normal match on your own server",
        buildId: build.id,
        playerName: config.settings.playerName,
        launchArgs: config.settings.launchArgs,
        headlessServer: true,
        playlist: "Playlist_DefaultSolo",
        tags: ["Solo"],
        ...classicMatch,
      };
      app.setConfig(await api.addProfile(p));
      profile = p;
    }
    const id = profile.id;
    useApp.setState((s) => ({ config: { ...s.config, activeProfileId: id } }));
    await api.setActiveProfile(id);
  } catch (e) {
    toast.error("Couldn't switch the profile", { description: errorText(e) });
    return;
  }
  void useDownloads.getState().dismiss(job.key);
  app.setPage("start");
  toast.success(`Fortnite ${build.version} is set`, { description: `Profile “${profile.name}”. Press Host & Play.` });
}

// ---- Browser preview: a pretend download (sped up about 75×) ------------------------------------

const DEMO_TICK_MS = 500;
/** Seconds of "real" download time per tick (a sped-up preview). */
const DEMO_SECONDS_PER_TICK = 75;
const DEMO_FILES = 751;
const demoFileNames = [
  "FortniteGame/Content/Paks/pakchunk0-WindowsClient.pak",
  "FortniteGame/Content/Paks/pakchunk10-WindowsClient.pak",
  "FortniteGame/Content/Paks/pakchunk1001-WindowsClient.ucas",
  "FortniteGame/Content/Paks/pakchunk11-WindowsClient.pak",
  "FortniteGame/Content/Paks/global.utoc",
  "FortniteGame/Binaries/Win64/FortniteClient-Win64-Shipping.exe",
  "FortniteGame/Content/Paks/pakchunk30_s9-WindowsClient.ucas",
  "Engine/Binaries/ThirdParty/NVIDIA/NVaftermath/Win64/GFSDK_Aftermath_Lib.x64.dll",
];

interface DemoRun {
  build: CatalogBuild;
  folder: string;
  phase: DownloadPhase;
  done: number;
  files: number;
  timer?: number;
}

const demo = {
  runs: new Map<string, DemoRun>(),

  find(key: string): CatalogBuild | undefined {
    return catalogBuilds(demoCatalog).find((b) => b.key === key);
  },

  progress(r: DemoRun): DownloadProgress {
    const { build } = r;
    const speed = r.phase === "downloading" ? 11.6e6 + Math.sin(Date.now() / 900) * 0.7e6 : 0;
    const total = r.phase === "verifying" ? build.installedBytes : r.phase === "importing" ? 0 : build.downloadBytes;
    const left = Math.max(0, total - r.done);
    const eta = r.phase === "downloading" ? left / speed : r.phase === "checking" ? (left / total) * 70 : null;
    return {
      key: build.key,
      phase: r.phase,
      bytesDone: Math.min(r.done, total),
      bytesTotal: total,
      filesDone: r.files,
      filesTotal: DEMO_FILES,
      speedBps: Math.round(speed),
      etaSecs: eta === null ? null : Math.round(eta),
      currentFile: r.phase === "downloading" || r.phase === "verifying" ? demoFileNames[Math.floor(r.done / 3.1e9) % demoFileNames.length] : "",
    };
  },

  tick(key: string) {
    const r = demo.runs.get(key);
    if (!r) return;
    const { build } = r;
    if (r.phase === "checking") {
      r.done += build.downloadBytes / 9;
      if (r.done >= build.downloadBytes) {
        r.phase = "downloading";
        r.done = 0;
      }
    } else if (r.phase === "downloading") {
      r.done += 11.6e6 * DEMO_SECONDS_PER_TICK;
      r.files = Math.min(DEMO_FILES - 1, Math.floor((r.done / build.downloadBytes) * DEMO_FILES));
      if (r.done >= build.downloadBytes) {
        r.phase = "verifying";
        r.done = 0;
        r.files = 0;
      }
    } else if (r.phase === "verifying") {
      r.done += build.installedBytes / 6;
      r.files = Math.min(DEMO_FILES, Math.floor((r.done / build.installedBytes) * DEMO_FILES));
      if (r.done >= build.installedBytes) {
        r.phase = "importing";
        r.done = 0;
      }
    } else {
      demo.finish(key);
      return;
    }
    onProgress(demo.progress(r));
    r.timer = window.setTimeout(() => demo.tick(key), DEMO_TICK_MS);
  },

  run(r: DemoRun) {
    window.clearTimeout(demo.runs.get(r.build.key)?.timer);
    demo.runs.set(r.build.key, r);
    onState({ key: r.build.key, state: "running" });
    onProgress(demo.progress(r));
    r.timer = window.setTimeout(() => demo.tick(r.build.key), DEMO_TICK_MS);
  },

  start(build: CatalogBuild, folder: string) {
    const running = useDownloads.getState().jobs.find((j) => j.state === "running");
    if (running) {
      throw running.key === build.key
        ? { code: "ALREADY_RUNNING", message: "This version is already downloading." }
        : { code: "ANOTHER_RUNNING", message: "Another version is downloading. Pause it first, then start this one." };
    }
    // Same checks and texts as Rust's folder rules (preview: E: is a FAT32 stick, F: is full)
    const f = folder.trim();
    if (!/^[a-z]:\\/i.test(f) || /\\program files/i.test(f)) {
      throw { code: "WRITE_FAILED", message: "Niobium can't write to this folder. Pick another one (not inside Program Files)." };
    }
    if (/^e:/i.test(f)) {
      throw { code: "FAT32", message: "Drive E: can't hold files bigger than 4 GB (FAT32). Pick a folder on another drive." };
    }
    if (/^f:/i.test(f)) {
      const need = formatGB(spaceNeeded(build.installedBytes));
      throw {
        code: "NOT_ENOUGH_SPACE",
        message: `There isn't enough free space on drive F:. This version needs ${need} and 12.3 GB is free. Free up space or pick another folder.`,
      };
    }
    if (/\\onedrive/i.test(f)) {
      throw { code: "ONEDRIVE", message: "This folder is synced by OneDrive. Pick a folder outside OneDrive, or it will try to upload the whole game (up to about 120 GB)." };
    }
    // Let the start finish first (the job is in the list once download_start returned)
    window.setTimeout(() => demo.run({ build, folder, phase: "checking", done: 0, files: 0 }), 0);
  },

  pause(key: string) {
    const r = demo.runs.get(key);
    if (r) window.clearTimeout(r.timer);
    window.setTimeout(() => onState({ key, state: "paused" }), 450);
  },

  resume(key: string) {
    const r = demo.runs.get(key);
    const build = r?.build ?? demo.find(key);
    if (!build) throw { code: "UNKNOWN_BUILD", message: "Niobium can't download this version." };
    const job = useDownloads.getState().jobs.find((j) => j.key === key);
    demo.run(r ?? { build, folder: job?.folder ?? "", phase: "downloading", done: job?.progress.bytesDone ?? 0, files: job?.progress.filesDone ?? 0 });
  },

  cancel(key: string, deleteFiles: boolean) {
    const r = demo.runs.get(key);
    const wasRunning = useDownloads.getState().jobs.find((j) => j.key === key)?.state === "running";
    if (r) window.clearTimeout(r.timer);
    demo.runs.delete(key);
    console.info("[Preview] download_cancel", key, { deleteFiles });
    if (wasRunning) window.setTimeout(() => onState({ key, state: "cancelled" }), 600);
  },

  async finish(key: string) {
    const r = demo.runs.get(key);
    demo.runs.delete(key);
    if (!r) return;
    const build = demoBuildInfo(r.build, r.folder);
    try {
      useApp.getState().setConfig(await api.addBuild(build));
    } catch {
      /* preview only */
    }
    onState({ key, state: "done" });
    onDone({ key, buildId: build.id });
    toast.success(`${r.build.version} is ready`, { description: `${r.build.version} is ready. Press Play.` });
  },

  /** Puts the preview into one state for screenshots (?dl=…). */
  seed(kind: string | null) {
    if (!kind) return;
    const builds = catalogBuilds(demoCatalog);
    const pick = (key: string) => builds.find((b) => b.key === key) ?? builds[0];
    const b1830 = pick("18.30-CL-17882303");
    const folder = (b: CatalogBuild) => `D:\\Niobium\\Builds\\${b.key}`;
    const job = (b: CatalogBuild, state: DownloadState, p: Partial<DownloadProgress>, error: DownloadError | null = null): DownloadJobView => ({
      key: b.key,
      version: b.version,
      cl: b.cl,
      folder: folder(b),
      state,
      progress: { ...emptyProgress(b.key, "downloading"), bytesTotal: b.downloadBytes, filesTotal: DEMO_FILES, ...p },
      error,
      buildId: null,
      // only the "chunks" preview stopped before writing anything
      filesKept: error?.code !== "CHUNKS_MISSING",
      pending: null,
    });
    if (kind === "running") {
      const done = b1830.downloadBytes * 0.38;
      upsert(job(b1830, "running", { bytesDone: done }));
      demo.run({ build: b1830, folder: folder(b1830), phase: "downloading", done, files: Math.floor(0.38 * DEMO_FILES) });
    } else if (kind === "checking") {
      upsert(job(b1830, "running", { phase: "checking" }));
      demo.run({ build: b1830, folder: folder(b1830), phase: "checking", done: b1830.downloadBytes * 0.3, files: 0 });
    } else if (kind === "verifying") {
      upsert(job(b1830, "running", { phase: "verifying" }));
      demo.run({ build: b1830, folder: folder(b1830), phase: "verifying", done: 0, files: 0 });
    } else if (kind === "paused") {
      demo.runs.set(b1830.key, { build: b1830, folder: folder(b1830), phase: "downloading", done: b1830.downloadBytes * 0.52, files: 391 });
      upsert(job(b1830, "paused", { bytesDone: b1830.downloadBytes * 0.52, filesDone: 391 }));
    } else if (kind === "error") {
      demo.runs.set(b1830.key, { build: b1830, folder: folder(b1830), phase: "downloading", done: b1830.downloadBytes * 0.63, files: 474 });
      upsert(
        job(b1830, "error", { bytesDone: b1830.downloadBytes * 0.63, filesDone: 474 }, {
          code: "NETWORK",
          message: "The connection to Epic's download servers dropped. Press Resume and Niobium continues where it stopped.",
        }),
      );
    } else if (kind === "chunks") {
      const b = pick("17.50-CL-17388565");
      upsert(
        job(b, "error", { phase: "checking", bytesDone: b.downloadBytes * 0.71, filesDone: 0 }, {
          code: "CHUNKS_MISSING",
          message:
            "Epic no longer has all the files for this version, so it can't be downloaded. Nothing was downloaded. Pick another version, or add a copy you already have with 'Add a build'.",
        }),
      );
    } else if (kind === "ready") {
      const b = pick("16.00-CL-15685441");
      const build = demoBuildInfo(b, folder(b));
      void api.addBuild(build).then((c) => useApp.getState().setConfig(c));
      upsert({
        ...job(b, "done", { phase: "importing", bytesDone: 0, bytesTotal: 0, filesDone: DEMO_FILES }),
        buildId: build.id,
      });
    }
  },
};

/** What "Add to Library" would find in the folder (preview only). */
function demoBuildInfo(b: CatalogBuild, folder: string): BuildInfo {
  const major = Number(b.version.split(".")[0]);
  return {
    id: `${b.version}-${b.cl}`,
    version: b.version,
    changelist: b.cl,
    season: seasonLabelOf(demoCatalog, b.key) || "Chapter 2",
    engine: major >= 14 ? "Unreal Engine 4.26" : "Unreal Engine 4.24",
    path: folder,
    binaries: `${folder}\\FortniteGame\\Binaries\\Win64`,
    support: "experimental",
    supportNote: "Untested – we'll try to start it",
    launchArgs: "-d3d11",
  };
}
