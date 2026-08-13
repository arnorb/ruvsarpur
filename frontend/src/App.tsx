// frontend/src/App.tsx
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Clapperboard, Download, Film, FolderOpen, Languages, Plus, RefreshCw, Search, Settings, Tv, Volleyball, X, XCircle } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ShowItem = {
  pid: string;
  sid: string;
  title: string;
  seriesTitle: string;
  description?: string | null;
  episodeDescription?: string | null;
  seriesDescription?: string | null;
  publishedAt: string;
  durationSeconds?: number;
  durationLabel?: string | null;
  firstAppearedAt?: string | null;
  expiresAt?: string | null;
  webUrl?: string;
  posterUrl?: string | null;
  isFollowed?: boolean;
  isDownloaded?: boolean;
  contentType?: "movie_or_docu" | "sport" | "show";
  categories?: string[];
  subtitleLanguages?: string[];
  englishSubtitledVersion?: boolean;
};

type BrowserWritableFile = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

type BrowserDirectoryHandle = {
  name: string;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  getFileHandle(name: string, options: { create: boolean }): Promise<{
    createWritable(): Promise<BrowserWritableFile>;
  }>;
};

const DOWNLOAD_FOLDER_DB = "ruvsarpur-browser-settings";
const DOWNLOAD_FOLDER_STORE = "handles";

const openDownloadFolderDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DOWNLOAD_FOLDER_DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(DOWNLOAD_FOLDER_STORE);
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const loadDefaultDownloadFolder = async () => {
  const database = await openDownloadFolderDb();
  return new Promise<BrowserDirectoryHandle | null>((resolve, reject) => {
    const request = database.transaction(DOWNLOAD_FOLDER_STORE).objectStore(DOWNLOAD_FOLDER_STORE).get("default");
    request.onsuccess = () => resolve((request.result as BrowserDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error);
  }).finally(() => database.close());
};

const storeDefaultDownloadFolder = async (folder: BrowserDirectoryHandle | null) => {
  const database = await openDownloadFolderDb();
  await new Promise<void>((resolve, reject) => {
    const store = database.transaction(DOWNLOAD_FOLDER_STORE, "readwrite").objectStore(DOWNLOAD_FOLDER_STORE);
    const request = folder ? store.put(folder, "default") : store.delete("default");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  database.close();
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<BrowserDirectoryHandle>;
  }
}

type DownloadMode = "web" | "library";
type SortBy = "name" | "duration" | "firstAppearance" | "lastAppearance" | "expiry";
type DownloadChoice = { shows: ShowItem[]; mode: DownloadMode };
type DownloadFile = { downloadUrl: string; fileName: string; kind: "video" | "subtitle" };
type DownloadJob = {
  id: string; pid: string; title: string; mode: DownloadMode;
  status: "queued" | "downloading" | "processing" | "completed" | "failed" | "cancelled";
  progress: number; stage: string; message: string; files: DownloadFile[];
  createdAt?: string; startedAt?: string | null; finishedAt?: string | null;
};
type RefreshStatus = {
  id: string | null; status: "idle" | "running" | "completed" | "failed";
  progress: number; completed: number; total: number; stage: string; message: string;
};

type AutoSettings = {
  watchlistSids: string[];
  autoEnabled: boolean;
  autoIntervalMinutes: number;
  outputDir: string;
  libraryRootDir: string;
  showsSubdir: string;
  moviesSubdir: string;
  sportsSubdir: string;
  plexBaseUrl: string;
  plexToken: string;
  plexLibrarySectionId: string;
  plexLibraryPath: string;
};

type AutoStatus = {
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
};

function getLibraryDestination(settings: AutoSettings, shows: ShowItem[]): string {
  const contentType = shows[0]?.contentType ?? "show";
  const subdirectory = contentType === "movie_or_docu"
    ? settings.moviesSubdir
    : contentType === "sport"
      ? settings.sportsSubdir
      : settings.showsSubdir;
  const root = (settings.libraryRootDir || settings.outputDir || "Library root").replace(/[\\/]+$/, "");
  const child = (subdirectory || "").replace(/^[\\/]+/, "");
  return child ? `${root}/${child}` : root;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000";
const PAGE_SIZE = 100;
const TRAILING_PARENTHESIS_REGEX = /\s*\([^)]*\)\s*$/;
const CONTENT_GROUP_ORDER: Array<"movie_or_docu" | "sport" | "show"> = [
  "movie_or_docu",
  "sport",
  "show",
];
const CONTENT_GROUP_LABEL: Record<"movie_or_docu" | "sport" | "show", string> = {
  movie_or_docu: "Movies & Docs",
  sport: "Sports",
  show: "Shows",
};

function toApiUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith("/")) {
    return `${API_BASE_URL}${pathOrUrl}`;
  }
  return `${API_BASE_URL}/${pathOrUrl}`;
}

async function parseApiResponse<T extends { error?: string }>(response: Response): Promise<T> {
  const contentType = response.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as T;
  }

  const rawBody = (await response.text()).trim();
  const normalizedBody = rawBody.replace(/\s+/g, " ").trim();
  if (!response.ok) {
    if ([502, 503].includes(response.status)) {
      return {
        error: "The RÚV service is still starting. Please wait a moment.",
      } as T;
    }
    if (response.status === 504) {
      return {
        error: "Refresh request timed out at the web proxy. The backend may still be processing. Try again shortly.",
      } as T;
    }
    return {
      error:
        normalizedBody.slice(0, 220) ||
        `Request failed (${response.status}). API returned a non-JSON response.`,
    } as T;
  }

  throw new Error("API returned a non-JSON response");
}

function formatDate(isoDate: string): string {
  if (!isoDate) return "Unknown date";
  return new Intl.DateTimeFormat("is-IS", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoDate));
}

function normalizeSeriesLabel(rawTitle: string): string {
  let title = (rawTitle ?? "").trim();
  // Remove trailing parenthesized suffixes like "(1 af 8)" from series labels.
  while (title.length > 0) {
    const updated = title.replace(TRAILING_PARENTHESIS_REGEX, "").trim();
    if (updated === title) break;
    title = updated;
  }
  return title;
}

function getGroupTitle(sidShows: ShowItem[]): string {
  const explicit = sidShows
    .map((show) => normalizeSeriesLabel(show.seriesTitle))
    .find((title) => title.length > 0);
  if (explicit) return explicit;

  const fromTitle = sidShows
    .map((show) => normalizeSeriesLabel(show.title))
    .find((title) => title.length > 0);
  if (fromTitle) return fromTitle;

  return "Untitled series";
}

function getGroupPosterUrl(sidShows: ShowItem[]): string | null {
  const rawPosterUrl = sidShows.find((show) => !!show.posterUrl)?.posterUrl ?? null;
  if (!rawPosterUrl) return null;
  return toApiUrl(rawPosterUrl);
}

function getGroupContentType(sidShows: ShowItem[]): "movie_or_docu" | "sport" | "show" {
  return sidShows[0]?.contentType ?? "show";
}

function isSidFollowed(sidShows: ShowItem[]): boolean {
  return sidShows.some((show) => show.isFollowed);
}

function getGroupDescription(sidShows: ShowItem[]): string | null {
  const candidates = sidShows
    .flatMap((show) => [show.seriesDescription, show.description, show.episodeDescription])
    .map((value) => (value ?? "").trim())
    .filter((value) => value.length > 0);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.length - a.length)[0];
}

function getEpisodeDescription(show: ShowItem): string | null {
  const description = show.episodeDescription ?? show.description ?? show.seriesDescription;
  const normalized = (description ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function formatDateOnly(isoDate?: string | null): string | null {
  if (!isoDate) return null;
  return new Intl.DateTimeFormat("is-IS", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoDate));
}

function formatDuration(show: ShowItem): string | null {
  const seconds = Number(show.durationSeconds ?? 0);
  if (seconds > 0) {
    const totalMinutes = Math.max(1, Math.round(seconds / 60));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours > 0 ? `${hours} hr ${minutes > 0 ? `${minutes} min` : ""}`.trim() : `${minutes} min`;
  }
  const label = (show.durationLabel ?? "").trim();
  return label.length > 0 ? label : null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function SubtitleBadges({ show }: { show: ShowItem }) {
  const hasIcelandic = show.subtitleLanguages?.includes("is");
  const hasEnglish = show.subtitleLanguages?.includes("en");
  if (!hasIcelandic && !hasEnglish && !show.englishSubtitledVersion && !show.isDownloaded) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {show.isDownloaded ? <span className="rounded bg-emerald-700/60 px-1.5 py-0.5 text-[10px] font-medium text-emerald-100">Downloaded</span> : null}
      {hasIcelandic ? <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300">IS subtitles</span> : null}
      {hasEnglish ? <span className="rounded bg-sky-700/60 px-1.5 py-0.5 text-[10px] text-sky-100">EN subtitles</span> : null}
      {show.englishSubtitledVersion ? <span className="rounded bg-violet-700/60 px-1.5 py-0.5 text-[10px] text-violet-100">English video version</span> : null}
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();
  const { sid: routeSid } = useParams<{ sid?: string }>();
  const selectedSid = routeSid ?? null;
  const [query, setQuery] = useState("");
  const [shows, setShows] = useState<ShowItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState<string | null>(null);
  const [refreshProgress, setRefreshProgress] = useState(0);
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>({ id: null, status: "idle", progress: 0, completed: 0, total: 0, stage: "Idle", message: "" });
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [viewMode, setViewMode] = useState<"list" | "poster">("poster");
  const [posterColumns, setPosterColumns] = useState(() => {
    const savedColumns = Number(window.localStorage.getItem("ruvsarpur-poster-columns"));
    return savedColumns >= 5 && savedColumns <= 15 ? savedColumns : 10;
  });
  const [contentFilter, setContentFilter] = useState<"movie_or_docu" | "sport" | "show">("show");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [subtitleFilter, setSubtitleFilter] = useState<"all" | "is" | "en" | "english-version">("all");
  const [sortBy, setSortBy] = useState<SortBy>("lastAppearance");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [downloadChoice, setDownloadChoice] = useState<DownloadChoice | null>(null);
  const [selectedEpisodePids, setSelectedEpisodePids] = useState<Set<string>>(new Set());
  const [downloadJobs, setDownloadJobs] = useState<DownloadJob[]>([]);
  const [isDownloadQueueOpen, setIsDownloadQueueOpen] = useState(true);
  const [defaultDownloadFolder, setDefaultDownloadFolder] = useState<BrowserDirectoryHandle | null>(null);
  const [selectedSubtitleLanguages, setSelectedSubtitleLanguages] = useState<string[]>([]);
  const [showAutomationSettings, setShowAutomationSettings] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState<AutoSettings>({
    watchlistSids: [],
    autoEnabled: false,
    autoIntervalMinutes: 60,
    outputDir: "",
    libraryRootDir: "",
    showsSubdir: "shows",
    moviesSubdir: "movies",
    sportsSubdir: "sports",
    plexBaseUrl: "",
    plexToken: "",
    plexLibrarySectionId: "",
    plexLibraryPath: "",
  });
  const [autoStatus, setAutoStatus] = useState<AutoStatus>({
    isRunning: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
  });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [startupGraceElapsed, setStartupGraceElapsed] = useState(false);
  const handledRefreshRef = useRef<string | null>(null);
  const downloadTickerRef = useRef<Record<string, number>>({});
  const downloadFoldersRef = useRef<Record<string, BrowserDirectoryHandle>>({});
  const handledDownloadJobsRef = useRef<Set<string>>(new Set());

  const hasQuery = useMemo(() => query.trim().length > 0, [query]);
  const visibleErrorMessage = useMemo(() => {
    if (!errorMessage) return "";
    const isProxyError = /<\/?html|502 bad gateway|503 service unavailable|nginx\//i.test(errorMessage);
    if (isProxyError) {
      if (!startupGraceElapsed || shows.length > 0) return "";
      return "The RÚV service has not started after 15 seconds. Try stopping and starting it again.";
    }
    return startupGraceElapsed || shows.length > 0 ? errorMessage : "";
  }, [errorMessage, shows.length, startupGraceElapsed]);
  const groupedAllShows = useMemo(() => {
    const grouped: Record<string, ShowItem[]> = {};
    for (const show of shows) {
      if (!grouped[show.sid]) grouped[show.sid] = [];
      grouped[show.sid].push(show);
    }
    const groupedEntries = Object.entries(grouped).map(([sid, sidShows]) => {
      const sortedEpisodes = [...sidShows].sort(
        (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
      );
      return [sid, sortedEpisodes] as [string, ShowItem[]];
    });
    // Sort series by newest episode first.
    groupedEntries.sort((a, b) => {
      const aType = getGroupContentType(a[1]);
      const bType = getGroupContentType(b[1]);
      const typeOrderDelta = CONTENT_GROUP_ORDER.indexOf(aType) - CONTENT_GROUP_ORDER.indexOf(bType);
      if (typeOrderDelta !== 0) return typeOrderDelta;
      return new Date(b[1][0]?.publishedAt ?? 0).getTime() - new Date(a[1][0]?.publishedAt ?? 0).getTime();
    });
    return groupedEntries;
  }, [shows]);

  const allCategories = useMemo(
    () =>
      Array.from(new Set(shows.flatMap((show) => show.categories ?? []))).sort((a, b) =>
        a.localeCompare(b, "is"),
      ),
    [shows],
  );

  const filteredGroupedAllShows = useMemo(() => {
      const filtered = groupedAllShows.filter((group) => {
        const groupShows = group[1];
        if (getGroupContentType(groupShows) !== contentFilter) return false;
        if (selectedCategories.length > 0 && !groupShows.some((show) => show.categories?.some((category) => selectedCategories.includes(category)))) {
          return false;
        }
        if (subtitleFilter === "is" && !groupShows.some((show) => show.subtitleLanguages?.includes("is"))) {
          return false;
        }
        if (subtitleFilter === "en" && !groupShows.some((show) => show.subtitleLanguages?.includes("en"))) {
          return false;
        }
        if (subtitleFilter === "english-version" && !groupShows.some((show) => show.englishSubtitledVersion)) {
          return false;
        }
        return true;
      });
      const dateValue = (value?: string | null, fallback = 0) => value ? new Date(value).getTime() : fallback;
      const groupValue = ([, groupShows]: [string, ShowItem[]]): string | number => {
        if (sortBy === "name") return getGroupTitle(groupShows).toLocaleLowerCase("is");
        if (sortBy === "duration") return Math.max(...groupShows.map((show) => Number(show.durationSeconds ?? 0)));
        if (sortBy === "firstAppearance") return Math.min(...groupShows.map((show) => dateValue(show.firstAppearedAt ?? show.publishedAt, sortDirection === "asc" ? Number.MAX_SAFE_INTEGER : -1)));
        if (sortBy === "expiry") return Math.min(...groupShows.map((show) => dateValue(show.expiresAt, sortDirection === "asc" ? Number.MAX_SAFE_INTEGER : -1)));
        return Math.max(...groupShows.map((show) => dateValue(show.publishedAt)));
      };
      return [...filtered].sort((a, b) => {
        const aValue = groupValue(a);
        const bValue = groupValue(b);
        const comparison = typeof aValue === "string" && typeof bValue === "string"
          ? aValue.localeCompare(bValue, "is")
          : Number(aValue) - Number(bValue);
        return sortDirection === "asc" ? comparison : -comparison;
      });
    },
    [groupedAllShows, contentFilter, selectedCategories, subtitleFilter, sortBy, sortDirection],
  );
  const filteredGroupedPageShows = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    return filteredGroupedAllShows.slice(start, end);
  }, [filteredGroupedAllShows, currentPage]);
  const categorizedPageShows = useMemo(() => {
    const categorized: Record<"movie_or_docu" | "sport" | "show", Array<[string, ShowItem[]]>> = {
      movie_or_docu: [],
      sport: [],
      show: [],
    };
    for (const group of filteredGroupedPageShows) {
      categorized[getGroupContentType(group[1])].push(group);
    }
    return categorized;
  }, [filteredGroupedPageShows]);
  const totalItemsForView = filteredGroupedAllShows.length;
  const totalPages = Math.max(1, Math.ceil(totalItemsForView / PAGE_SIZE));
  const pageStartIndex = totalItemsForView === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const pageEndIndex = Math.min(currentPage * PAGE_SIZE, totalItemsForView);
  const episodesForSelectedSid = useMemo(() => {
    if (!selectedSid) return [];
    return groupedAllShows.find(([sid]) => sid === selectedSid)?.[1] ?? [];
  }, [selectedSid, groupedAllShows]);
  const selectedSidFollowed = useMemo(() => {
    if (episodesForSelectedSid.length === 0) return false;
    return isSidFollowed(episodesForSelectedSid);
  }, [episodesForSelectedSid]);
  const selectedSidDescription = useMemo(
    () => getGroupDescription(episodesForSelectedSid),
    [episodesForSelectedSid],
  );
  const selectedSidPosterUrl = useMemo(() => getGroupPosterUrl(episodesForSelectedSid), [episodesForSelectedSid]);
  const selectedContentType = useMemo(
    () => getGroupContentType(episodesForSelectedSid),
    [episodesForSelectedSid],
  );
  const selectedPrimaryItem = useMemo(() => episodesForSelectedSid[0] ?? null, [episodesForSelectedSid]);
  const followedCount = useMemo(() => shows.filter((show) => show.isFollowed).length, [shows]);

  const startDownloadTicker = (pid: string) => {
    const existingTicker = downloadTickerRef.current[pid];
    if (existingTicker !== undefined) window.clearInterval(existingTicker);
    setDownloadProgress((current) => ({ ...current, [pid]: 8 }));
    downloadTickerRef.current[pid] = window.setInterval(() => {
      setDownloadProgress((current) => ({
        ...current,
        [pid]: current[pid] >= 92 ? current[pid] : Math.min(92, (current[pid] ?? 0) + 5),
      }));
    }, 300);
  };

  const stopDownloadTicker = (pid: string) => {
    const ticker = downloadTickerRef.current[pid];
    if (ticker !== undefined) {
      window.clearInterval(ticker);
      delete downloadTickerRef.current[pid];
    }
    setDownloadProgress((current) => ({ ...current, [pid]: 100 }));
    window.setTimeout(() => {
      setDownloadProgress((current) => {
        const next = { ...current };
        delete next[pid];
        return next;
      });
    }, 450);
  };

  const loadShows = async (refresh: boolean, queryOverride?: string) => {
    setIsLoading(true);
    setErrorMessage("");
    setStatusMessage(refresh ? "Refreshing list..." : shows.length === 0 ? "Starting the RÚV service..." : "Loading list...");
    try {
      const queryParam = encodeURIComponent((queryOverride ?? query).trim());
      const requestUrl = `${API_BASE_URL}/api/shows?query=${queryParam}&refresh=${refresh ? "1" : "0"}`;
      let response: Response | null = null;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        response = await fetch(requestUrl);
        if (![502, 503, 504].includes(response.status)) break;
        setStatusMessage("Starting the RÚV service...");
        await wait(1000);
      }
      if (!response) throw new Error("The RÚV service did not respond");
      const data = await parseApiResponse<{ shows?: ShowItem[]; error?: string }>(response);
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to fetch shows");
      }
      setShows(data.shows ?? []);
      setCurrentPage(1);
      setImageLoadFailed({});
      setStatusMessage("");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while loading shows";
      setErrorMessage(message);
      setStatusMessage("");
    } finally {
      setIsLoading(false);
    }
  };

  const fetchRefreshStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/refresh/status`);
      const data = await parseApiResponse<{ status?: RefreshStatus; error?: string }>(response);
      if (!response.ok || !data.status) return;
      setRefreshStatus(data.status);
      setRefreshProgress(data.status.progress);
      if (data.status.status === "running") {
        setStatusMessage(`${data.status.stage}: ${data.status.message}`);
      } else if (data.status.status === "failed") {
        setErrorMessage(data.status.message || "Refresh failed");
        setStatusMessage("");
      } else if (data.status.status === "completed" && data.status.id && handledRefreshRef.current !== data.status.id) {
        handledRefreshRef.current = data.status.id;
        setStatusMessage(data.status.message);
        await loadShows(false);
        window.setTimeout(() => setRefreshProgress(0), 600);
      }
    } catch {
      // A temporary polling failure should not interrupt the rest of the page.
    }
  };

  const startScheduleRefresh = async () => {
    setErrorMessage("");
    setStatusMessage("Connecting to RÚV...");
    try {
      const response = await fetch(`${API_BASE_URL}/api/refresh`, { method: "POST" });
      const data = await parseApiResponse<{ status?: RefreshStatus; error?: string }>(response);
      if (!response.ok && response.status !== 409) throw new Error(data.error ?? "Could not start refresh");
      if (data.status) {
        setRefreshStatus(data.status);
        setRefreshProgress(data.status.progress);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not start refresh");
      setStatusMessage("");
    }
  };

  const loadSettings = async () => {
    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        response = await fetch(`${API_BASE_URL}/api/settings`);
        if (![502, 503, 504].includes(response.status)) break;
        await wait(1000);
      }
      if (!response) return;
      const data = await parseApiResponse<{ settings?: AutoSettings; status?: AutoStatus; error?: string }>(response);
      if (!response.ok) {
        if ([502, 503, 504].includes(response.status)) return;
        throw new Error(data.error ?? "Failed to load settings");
      }
      if (data.settings) setSettings(data.settings);
      if (data.status) setAutoStatus(data.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while loading settings";
      setErrorMessage(message);
    }
  };

  const saveSettings = async () => {
    setIsSavingSettings(true);
    setErrorMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await parseApiResponse<{ settings?: AutoSettings; error?: string }>(response);
      if (!response.ok) throw new Error(data.error ?? "Failed to save settings");
      if (data.settings) setSettings(data.settings);
      setStatusMessage("Automation settings saved.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while saving settings";
      setErrorMessage(message);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const fetchAutoStatus = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auto/status`);
      const data = await parseApiResponse<{ status?: AutoStatus; error?: string }>(response);
      if (!response.ok) throw new Error(data.error ?? "Failed to load auto status");
      if (data.status) setAutoStatus(data.status);
    } catch {
      // Ignore polling errors to avoid noisy UI.
    }
  };

  const runAutoNow = async () => {
    setErrorMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/api/auto/run-now`, { method: "POST" });
      const data = await parseApiResponse<{ message?: string; error?: string }>(response);
      if (!response.ok) throw new Error(data.error ?? "Failed to start auto run");
      setStatusMessage(data.message ?? "Auto download started.");
      await fetchAutoStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while starting auto run";
      setErrorMessage(message);
    }
  };

  const setFollowStateForSid = (sid: string, followed: boolean) => {
    setShows((current) => current.map((show) => (show.sid === sid ? { ...show, isFollowed: followed } : show)));
  };

  const changePage = (nextPage: number) => {
    setCurrentPage(nextPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const openDetailsPage = (sid: string) => {
    navigate(`/title/${encodeURIComponent(sid)}`);
  };

  const closeDetailsPage = () => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate("/");
  };

  const handleSidebarSelect = (nextFilter: "movie_or_docu" | "sport" | "show") => {
    setContentFilter(nextFilter);
    if (selectedSid) {
      navigate("/");
    }
  };

  const toggleFollowSid = async (sid: string, follow: boolean) => {
    setErrorMessage("");
    try {
      if (follow) {
        const response = await fetch(`${API_BASE_URL}/api/watchlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid }),
        });
        const data = await parseApiResponse<{ watchlistSids?: string[]; error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "Failed to follow series");
        setSettings((current) => ({ ...current, watchlistSids: data.watchlistSids ?? current.watchlistSids }));
      } else {
        const response = await fetch(`${API_BASE_URL}/api/watchlist?sid=${encodeURIComponent(sid)}`, {
          method: "DELETE",
        });
        const data = await parseApiResponse<{ watchlistSids?: string[]; error?: string }>(response);
        if (!response.ok) throw new Error(data.error ?? "Failed to unfollow series");
        setSettings((current) => ({ ...current, watchlistSids: data.watchlistSids ?? current.watchlistSids }));
      }
      setFollowStateForSid(sid, follow);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while updating watchlist";
      setErrorMessage(message);
    }
  };

  const openDownloadOptions = (show: ShowItem, mode: DownloadMode) => {
    setSelectedSubtitleLanguages(show.subtitleLanguages?.includes("is") ? ["is"] : []);
    setDownloadChoice({ shows: [show], mode });
  };

  const openBatchDownloadOptions = (mode: DownloadMode) => {
    const selectedShows = episodesForSelectedSid.filter((episode) => selectedEpisodePids.has(episode.pid));
    if (selectedShows.length === 0) return;
    setSelectedSubtitleLanguages(selectedShows.some((show) => show.subtitleLanguages?.includes("is")) ? ["is"] : []);
    setDownloadChoice({ shows: selectedShows, mode });
  };

  const resetToDefaultView = () => {
    navigate("/");
    setQuery("");
    setContentFilter("show");
    setSelectedCategories([]);
    setSubtitleFilter("all");
    setSortBy("lastAppearance");
    setSortDirection("desc");
    setViewMode("poster");
    setCurrentPage(1);
    void loadShows(false, "");
  };

  const clearSearch = () => {
    setQuery("");
    void loadShows(false, "");
  };

  const saveDownloadFilesToFolder = async (
    files: DownloadFile[],
    directoryHandle: BrowserDirectoryHandle,
  ) => {
    for (const file of files) {
      const response = await fetch(toApiUrl(file.downloadUrl));
      if (!response.ok) throw new Error(`Could not retrieve ${file.fileName}`);
      const targetFile = await directoryHandle.getFileHandle(file.fileName, { create: true });
      const writable = await targetFile.createWritable();
      await writable.write(await response.blob());
      await writable.close();
    }
  };

  const startBrowserDownloads = (files: DownloadFile[]) => {
    files.forEach((file, index) => {
      window.setTimeout(() => {
        const downloadAnchor = document.createElement("a");
        downloadAnchor.href = toApiUrl(file.downloadUrl);
        downloadAnchor.download = file.fileName;
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        document.body.removeChild(downloadAnchor);
      }, index * 250);
    });
  };

  const handleDownloads = async (
    selectedShows: ShowItem[],
    mode: DownloadMode,
    directoryHandle?: BrowserDirectoryHandle,
  ) => {
    setErrorMessage("");
    setDownloadChoice(null);
    setStatusMessage(`Adding ${selectedShows.length} item${selectedShows.length === 1 ? "" : "s"} to the queue...`);
    try {
      const queuedJobs: DownloadJob[] = [];
      for (const show of selectedShows) {
        const subtitleLanguages = selectedSubtitleLanguages.filter((language) => show.subtitleLanguages?.includes(language));
        const response = await fetch(`${API_BASE_URL}/api/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pid: show.pid,
            title: show.title,
            mode,
            contentType: show.contentType ?? "show",
            subtitleLanguages,
          }),
        });
        const data = await parseApiResponse<{ message?: string; job?: DownloadJob; error?: string }>(response);
        if (!response.ok || !data.job) throw new Error(data.error ?? `Could not queue ${show.title}`);
        if (directoryHandle) downloadFoldersRef.current[data.job.id] = directoryHandle;
        queuedJobs.push(data.job);
      }
      setDownloadJobs((current) => [...queuedJobs.reverse(), ...current.filter((job) => !queuedJobs.some((queued) => queued.id === job.id))]);
      setSelectedEpisodePids(new Set());
      setStatusMessage(`${selectedShows.length} item${selectedShows.length === 1 ? "" : "s"} added to the download queue.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while downloading";
      setErrorMessage(message);
      setStatusMessage("");
    }
  };

  const fetchDownloadJobs = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/download/jobs`);
      const data = await parseApiResponse<{ jobs?: DownloadJob[]; error?: string }>(response);
      if (!response.ok) return;
      const jobs = data.jobs ?? [];
      setDownloadJobs(jobs);
      const completedPids = new Set(jobs.filter((job) => job.status === "completed").map((job) => job.pid));
      if (completedPids.size > 0) {
        setShows((current) => current.map((show) => completedPids.has(show.pid) ? { ...show, isDownloaded: true } : show));
      }
      for (const job of jobs) {
        if (job.status !== "completed" || job.mode !== "web" || handledDownloadJobsRef.current.has(job.id)) continue;
        handledDownloadJobsRef.current.add(job.id);
        const folder = downloadFoldersRef.current[job.id];
        try {
          if (folder) {
            await saveDownloadFilesToFolder(job.files, folder);
            delete downloadFoldersRef.current[job.id];
          } else {
            startBrowserDownloads(job.files);
          }
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : "Could not save completed download");
        }
      }
    } catch {
      // Keep the page usable if a poll happens while the backend restarts.
    }
  };

  const cancelDownloadJob = async (jobId: string) => {
    await fetch(`${API_BASE_URL}/api/download/jobs?jobId=${encodeURIComponent(jobId)}`, { method: "DELETE" });
    await fetchDownloadJobs();
  };

  const clearFinishedDownloadJobs = async () => {
    const response = await fetch(`${API_BASE_URL}/api/download/jobs?clear=finished`, { method: "DELETE" });
    if (!response.ok) {
      setErrorMessage("Could not clear finished downloads from the queue.");
      return;
    }
    await fetchDownloadJobs();
  };

  const retryDownloadJob = async (job: DownloadJob) => {
    setErrorMessage("");
    const response = await fetch(`${API_BASE_URL}/api/download/jobs/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id }),
    });
    const data = await parseApiResponse<{ job?: DownloadJob; error?: string }>(response);
    if (!response.ok || !data.job) {
      setErrorMessage(data.error ?? "Could not retry the download.");
      return;
    }
    const previousFolder = downloadFoldersRef.current[job.id];
    if (previousFolder) downloadFoldersRef.current[data.job.id] = previousFolder;
    setDownloadJobs((current) => [data.job!, ...current]);
    setIsDownloadQueueOpen(true);
    setStatusMessage(`${job.title} was added to the queue again.`);
  };

  const chooseFolderAndDownload = async () => {
    if (!downloadChoice || !window.showDirectoryPicker) return;
    try {
      // Ask for write access while this button click still counts as a user
      // action. Waiting until the background download finishes is too late:
      // Chrome then refuses to prompt for permission.
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      let permission = directoryHandle.queryPermission
        ? await directoryHandle.queryPermission({ mode: "readwrite" })
        : "granted";
      if (permission !== "granted" && directoryHandle.requestPermission) {
        permission = await directoryHandle.requestPermission({ mode: "readwrite" });
      }
      if (permission !== "granted") throw new Error("Permission to save in the selected folder was not granted.");
      await handleDownloads(downloadChoice.shows, downloadChoice.mode, directoryHandle);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setErrorMessage(error instanceof Error ? error.message : "Could not use the selected folder");
    }
  };

  const chooseDefaultDownloadFolder = async () => {
    if (!window.showDirectoryPicker) return;
    try {
      const directoryHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      let permission = directoryHandle.queryPermission
        ? await directoryHandle.queryPermission({ mode: "readwrite" })
        : "granted";
      if (permission !== "granted" && directoryHandle.requestPermission) {
        permission = await directoryHandle.requestPermission({ mode: "readwrite" });
      }
      if (permission !== "granted") throw new Error("Permission to save in the selected folder was not granted.");
      await storeDefaultDownloadFolder(directoryHandle);
      setDefaultDownloadFolder(directoryHandle);
      setStatusMessage(`Default download folder set to ${directoryHandle.name}.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setErrorMessage(error instanceof Error ? error.message : "Could not remember the selected folder");
    }
  };

  const downloadToDefaultFolder = async () => {
    if (!downloadChoice || !defaultDownloadFolder) return;
    try {
      let permission = defaultDownloadFolder.queryPermission
        ? await defaultDownloadFolder.queryPermission({ mode: "readwrite" })
        : "granted";
      if (permission !== "granted" && defaultDownloadFolder.requestPermission) {
        permission = await defaultDownloadFolder.requestPermission({ mode: "readwrite" });
      }
      if (permission !== "granted") throw new Error("Permission to use the default download folder was not granted.");
      await handleDownloads(downloadChoice.shows, downloadChoice.mode, defaultDownloadFolder);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not use the default download folder");
    }
  };

  const forgetDefaultDownloadFolder = async () => {
    await storeDefaultDownloadFolder(null);
    setDefaultDownloadFolder(null);
    setStatusMessage("The default download folder was removed.");
  };

  const handleWebOpen = (show: ShowItem) => {
    const targetUrl = show.webUrl && show.webUrl.length > 0 ? show.webUrl : "https://www.ruv.is/sjonvarp";
    window.open(targetUrl, "_blank", "noopener,noreferrer");
  };

  useEffect(() => {
    void loadShows(false);
    void loadSettings();
    if (folderPickerAvailable) {
      void loadDefaultDownloadFolder().then(setDefaultDownloadFolder).catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setStartupGraceElapsed(true), 15000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    void fetchDownloadJobs();
    const timer = window.setInterval(() => void fetchDownloadJobs(), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetchRefreshStatus();
    const timer = window.setInterval(() => void fetchRefreshStatus(), 750);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchAutoStatus();
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCurrentPage(1);
  }, [contentFilter, selectedCategories, subtitleFilter]);

  useEffect(() => {
    setSelectedEpisodePids(new Set());
  }, [selectedSid]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    return () => {
      for (const pid in downloadTickerRef.current) {
        window.clearInterval(downloadTickerRef.current[pid]);
      }
    };
  }, []);

  const sidebarNav = [
    { key: "show" as const, label: "Shows", icon: <Tv className="h-5 w-5" /> },
    { key: "movie_or_docu" as const, label: "Movies", icon: <Film className="h-5 w-5" /> },
    { key: "sport" as const, label: "Sports", icon: <Volleyball className="h-5 w-5" /> },
  ];
  const folderPickerAvailable = window.isSecureContext && typeof window.showDirectoryPicker === "function";

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">

      {/* Left sidebar */}
      <aside className="sticky top-0 flex h-screen w-44 shrink-0 flex-col border-r border-slate-800 bg-slate-900/80 py-4 px-3">
        {/* Logo */}
        <button
          type="button"
          onClick={resetToDefaultView}
          className="mb-6 flex items-center gap-2 rounded-md text-left transition-colors hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          aria-label="Reset RÚV Sarpur view"
        >
          <Clapperboard className="h-6 w-6 shrink-0 text-sky-400" />
          <span className="text-base font-bold tracking-tight text-slate-100">RÚV Sarpur</span>
        </button>

        {/* Nav items */}
        <nav className="flex w-full flex-1 flex-col gap-1">
          {sidebarNav.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => handleSidebarSelect(key)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                contentFilter === key
                  ? "bg-sky-600/20 text-sky-300"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              }`}
            >
              <span className="shrink-0">{icon}</span>
              <span>{label}</span>
            </button>
          ))}
        </nav>

        {/* Settings at bottom */}
        <button
          onClick={() => setShowAutomationSettings(true)}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
        >
          <Settings className="h-5 w-5 shrink-0" />
          <span>Settings</span>
        </button>
      </aside>

      {/* Main content */}
      <main className="flex min-w-0 flex-1 flex-col">

        {/* Top bar */}
        <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/60 px-4 py-3">
          {/* Search */}
          <div className="flex h-9 flex-1 items-center overflow-hidden rounded-md border border-slate-700 bg-slate-800">
            <Search className="ml-3 h-4 w-4 shrink-0 text-slate-500" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by title"
              className="h-9 border-0 bg-transparent text-slate-100 placeholder:text-slate-500 focus-visible:ring-0 focus-visible:ring-offset-0"
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadShows(false);
              }}
            />
            {query.length > 0 ? (
              <button
                type="button"
                onClick={clearSearch}
                className="mr-1 rounded-full p-1 text-slate-500 transition-colors hover:bg-slate-700 hover:text-slate-200"
                aria-label="Clear search"
                title="Clear search"
              >
                <XCircle className="h-4 w-4" />
              </button>
            ) : null}
            <Button
              onClick={() => void loadShows(false)}
              variant="outline"
              disabled={isLoading}
              size="sm"
              className="mr-1 h-7 border-slate-700 bg-slate-700 px-3 text-xs text-slate-100 hover:bg-slate-600"
            >
              Search
            </Button>
          </div>

          {/* View toggle */}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              onClick={() => setViewMode("list")}
              size="sm"
              className={
                viewMode === "list"
                  ? "h-9 border border-slate-600 bg-slate-100 text-slate-900 hover:bg-white"
                  : "h-9 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
              }
              disabled={isLoading}
            >
              <Tv className="mr-2 h-4 w-4" />
              List
            </Button>
            <Button
              onClick={() => setViewMode("poster")}
              size="sm"
              className={
                viewMode === "poster"
                  ? "h-9 border border-slate-600 bg-slate-100 text-slate-900 hover:bg-white"
                  : "h-9 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
              }
              disabled={isLoading}
            >
              <Clapperboard className="mr-2 h-4 w-4" />
              Posters
            </Button>
          </div>

          {/* Status pills */}
          <div className="hidden items-center gap-2 text-xs lg:flex">
            <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-slate-300">
              {shows.length} episodes
            </span>
            <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1 text-slate-300">
              {followedCount} followed
            </span>
            <span
              className={`rounded-full border px-3 py-1 ${
                autoStatus.isRunning
                  ? "border-emerald-500/60 bg-emerald-500/20 text-emerald-300"
                  : "border-slate-700 bg-slate-800 text-slate-300"
              }`}
            >
              {autoStatus.isRunning ? "auto running" : "auto idle"}
            </span>
          </div>

          {/* Refresh */}
          <Button
            onClick={() => void startScheduleRefresh()}
            disabled={isLoading || refreshStatus.status === "running"}
            size="sm"
            className="relative h-9 shrink-0 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
          >
            <span
              className="absolute bottom-0 left-0 h-1 bg-sky-200/40 transition-[width] duration-200"
              style={{ width: `${refreshProgress}%` }}
            />
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshStatus.status === "running" ? "animate-spin" : ""}`} />
            {refreshStatus.status === "running" ? `${refreshStatus.completed}/${refreshStatus.total || "?"}` : "Refresh"}
          </Button>
        </header>

        {!selectedSid ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950/50 px-4 py-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Filters</span>
            <details className="group relative">
              <summary className="flex h-8 cursor-pointer list-none items-center rounded-md border border-slate-700 bg-slate-800 px-3 text-sm text-slate-200 hover:bg-slate-700">
                {selectedCategories.length === 0 ? "All categories" : `${selectedCategories.length} categories`}
              </summary>
              <div className="absolute left-0 top-10 z-30 max-h-80 w-64 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-2xl">
                <div className="mb-1 flex items-center justify-between border-b border-slate-800 px-2 pb-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Categories</span>
                  {selectedCategories.length > 0 ? <button className="text-xs text-sky-300 hover:text-sky-200" onClick={() => setSelectedCategories([])}>Clear</button> : null}
                </div>
                {allCategories.map((category) => (
                  <label key={category} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
                    <input
                      type="checkbox"
                      checked={selectedCategories.includes(category)}
                      onChange={(event) => setSelectedCategories((current) => event.target.checked ? [...current, category] : current.filter((item) => item !== category))}
                      className="h-4 w-4 accent-sky-500"
                    />
                    {category}
                  </label>
                ))}
              </div>
            </details>
            <select
              value={subtitleFilter}
              onChange={(event) => setSubtitleFilter(event.target.value as typeof subtitleFilter)}
              className="h-8 rounded-md border border-slate-700 bg-slate-800 px-2 text-sm text-slate-200"
              aria-label="Subtitle filter"
            >
              <option value="all">All subtitle options</option>
              <option value="is">Icelandic subtitles</option>
              <option value="en">English subtitle track</option>
              <option value="english-version">English-subtitled video</option>
            </select>
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortBy)}
              className="h-8 rounded-md border border-slate-700 bg-slate-800 px-2 text-sm text-slate-200"
              aria-label="Sort by"
            >
              <option value="name">Name</option>
              <option value="duration">Duration</option>
              <option value="firstAppearance">First appearance</option>
              <option value="lastAppearance">Last appearance</option>
              <option value="expiry">Expiry date</option>
            </select>
            <select
              value={sortDirection}
              onChange={(event) => setSortDirection(event.target.value as "asc" | "desc")}
              className="h-8 rounded-md border border-slate-700 bg-slate-800 px-2 text-sm text-slate-200"
              aria-label="Sort direction"
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            {viewMode === "poster" ? (
              <label className="ml-auto flex items-center gap-2 text-xs text-slate-400">
                <span>Poster columns</span>
                <input
                  type="range"
                  min="5"
                  max="15"
                  step="1"
                  value={posterColumns}
                  onChange={(event) => {
                    const columns = Number(event.target.value);
                    setPosterColumns(columns);
                    window.localStorage.setItem("ruvsarpur-poster-columns", String(columns));
                  }}
                  className="w-36 accent-sky-500"
                  aria-label="Poster columns"
                />
                <span className="w-5 text-right font-semibold text-slate-200">{posterColumns}</span>
              </label>
            ) : null}
            {(selectedCategories.length > 0 || subtitleFilter !== "all") ? (
              <button
                className="text-xs text-sky-300 hover:text-sky-200"
                onClick={() => { setSelectedCategories([]); setSubtitleFilter("all"); }}
              >
                Clear filters
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Content area */}
        <div className="flex-1 overflow-auto p-4 md:p-6">
          {statusMessage ? (
            <p className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              {statusMessage}
            </p>
          ) : null}
          {visibleErrorMessage ? (
            <p className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {visibleErrorMessage}
            </p>
          ) : null}

          <div className={viewMode === "poster" || selectedSid ? "" : "rounded-lg border border-slate-800 bg-slate-900/60"}>
            {selectedSid ? (
              <section className="space-y-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                  onClick={closeDetailsPage}
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back
                </Button>

                <div className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4 md:grid-cols-[220px_1fr]">
                  <div className="mx-auto w-full max-w-[220px]">
                    <div className="relative aspect-2/3 overflow-hidden rounded-lg border border-slate-800 bg-slate-800">
                      {selectedSidPosterUrl && !imageLoadFailed[selectedSid] ? (
                        <img
                          src={selectedSidPosterUrl}
                          alt={`${getGroupTitle(episodesForSelectedSid)} poster`}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={() => setImageLoadFailed((current) => ({ ...current, [selectedSid]: true }))}
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs font-medium text-slate-500">
                          No image
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xl font-semibold text-slate-100">{getGroupTitle(episodesForSelectedSid)}</p>
                        <p className="text-sm text-slate-400">
                          {CONTENT_GROUP_LABEL[getGroupContentType(episodesForSelectedSid)]} - {episodesForSelectedSid.length}{" "}
                          episode(s)
                        </p>
                      </div>
                      <Button
                        size="sm"
                        className={
                          selectedSidFollowed
                            ? "border border-sky-600/60 bg-sky-600/80 text-sky-50 hover:bg-rose-600/80 hover:border-rose-600/60 hover:text-rose-50"
                            : "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                        }
                        onClick={() => void toggleFollowSid(selectedSid, !selectedSidFollowed)}
                      >
                        {selectedSidFollowed ? (
                          <>
                            <Check className="mr-2 h-4 w-4" />
                            Following
                          </>
                        ) : (
                          <>
                            <Plus className="mr-2 h-4 w-4" />
                            Follow
                          </>
                        )}
                      </Button>
                    </div>

                    {selectedContentType === "movie_or_docu" && selectedPrimaryItem ? (
                      <div className="mb-4 space-y-3">
                        <p className="text-sm text-slate-500">Air date: {formatDate(selectedPrimaryItem.publishedAt)}{formatDuration(selectedPrimaryItem) ? ` · ${formatDuration(selectedPrimaryItem)}` : ""}{formatDateOnly(selectedPrimaryItem.expiresAt) ? ` · expires ${formatDateOnly(selectedPrimaryItem.expiresAt)}` : ""}</p>
                        <SubtitleBadges show={selectedPrimaryItem} />
                        {getEpisodeDescription(selectedPrimaryItem) ? (
                          <p className="text-sm leading-relaxed text-slate-300">
                            {getEpisodeDescription(selectedPrimaryItem)}
                          </p>
                        ) : null}
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => openDownloadOptions(selectedPrimaryItem, "web")}
                            className="relative h-8 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
                          >
                            <span
                              className="absolute bottom-0 left-0 h-1 bg-sky-200/50 transition-[width] duration-200"
                              style={{ width: `${downloadProgress[selectedPrimaryItem.pid] ?? 0}%` }}
                            />
                            <Download className="mr-2 h-4 w-4" />
                            Download
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => openDownloadOptions(selectedPrimaryItem, "library")} className="h-8 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700">Library</Button>
                        </div>
                      </div>
                    ) : selectedSidDescription ? (
                      <section className="mb-4 rounded-md border border-slate-800 bg-slate-900/70 p-3">
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Description</p>
                        <p className="text-sm leading-relaxed text-slate-300">{selectedSidDescription}</p>
                      </section>
                    ) : null}

                    {episodesForSelectedSid.length === 0 ? (
                      <p className="text-sm text-slate-500">No episodes found for this title.</p>
                    ) : selectedContentType !== "movie_or_docu" ? (
                      <div>
                        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/70 p-3">
                          <span className="mr-auto text-sm text-slate-300">{selectedEpisodePids.size} of {episodesForSelectedSid.length} selected</span>
                          <Button variant="outline" size="sm" className="h-8 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700" onClick={() => setSelectedEpisodePids(new Set(episodesForSelectedSid.map((episode) => episode.pid)))}>Select all</Button>
                          <Button variant="outline" size="sm" className="h-8 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700" onClick={() => setSelectedEpisodePids(new Set())}>None</Button>
                          <Button size="sm" disabled={selectedEpisodePids.size === 0} className="h-8 border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500" onClick={() => openBatchDownloadOptions("web")}><Download className="mr-2 h-4 w-4" />Download selected</Button>
                          <Button variant="outline" size="sm" disabled={selectedEpisodePids.size === 0} className="h-8 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700" onClick={() => openBatchDownloadOptions("library")}>Library selected</Button>
                        </div>
                        <ul className="space-y-2">
                        {episodesForSelectedSid.map((episode) => (
                          <li
                            key={episode.pid}
                            className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900/70 p-3"
                          >
                            <input
                              type="checkbox"
                              aria-label={`Select ${episode.title}`}
                              checked={selectedEpisodePids.has(episode.pid)}
                              onChange={(event) => setSelectedEpisodePids((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(episode.pid); else next.delete(episode.pid);
                                return next;
                              })}
                              className="h-4 w-4 shrink-0 accent-sky-500"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium text-slate-100">{episode.title}</p>
                              <p className="text-sm text-slate-500">{formatDate(episode.publishedAt)}{formatDuration(episode) ? ` · ${formatDuration(episode)}` : ""}{formatDateOnly(episode.expiresAt) ? ` · expires ${formatDateOnly(episode.expiresAt)}` : ""}</p>
                              <SubtitleBadges show={episode} />
                              {getEpisodeDescription(episode) ? (
                                <p className="mt-1 line-clamp-3 text-sm text-slate-300">{getEpisodeDescription(episode)}</p>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => openDownloadOptions(episode, "web")}
                                className="relative h-8 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
                              >
                                <span
                                  className="absolute bottom-0 left-0 h-1 bg-sky-200/50 transition-[width] duration-200"
                                  style={{ width: `${downloadProgress[episode.pid] ?? 0}%` }}
                                />
                                <Download className="mr-2 h-4 w-4" />
                                Download
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => openDownloadOptions(episode, "library")} className="h-8 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700">Library</Button>
                            </div>
                          </li>
                        ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : shows.length === 0 ? (
              <p className="p-4 text-sm text-slate-400">
                {hasQuery ? "No results for your search." : "No shows returned from backend."}
              </p>
            ) : viewMode === "list" ? (
              <div className="divide-y divide-slate-800">
                {CONTENT_GROUP_ORDER.map((groupType) =>
                  groupType === contentFilter && categorizedPageShows[groupType].length > 0 ? (
                    <section key={groupType} className="p-4">
                      <div className="space-y-4">
                        {categorizedPageShows[groupType].map(([sid, sidShows]) => (
                          <section key={sid}>
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <div>
                                <p className="text-sm font-semibold text-slate-100">
                                  {getGroupTitle(sidShows)}
                                </p>
                                <p className="text-xs text-slate-500">{sidShows.length} episode(s)</p>
                              </div>
                              <Button
                                size="sm"
                                className={
                                  isSidFollowed(sidShows)
                                    ? "border border-sky-600/60 bg-sky-600/80 text-sky-50 hover:bg-rose-600/80 hover:border-rose-600/60 hover:text-rose-50"
                                    : "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                                }
                                onClick={() => void toggleFollowSid(sid, !isSidFollowed(sidShows))}
                              >
                                {isSidFollowed(sidShows) ? (
                                  <><Check className="mr-2 h-4 w-4" />Following</>
                                ) : (
                                  <><Plus className="mr-2 h-4 w-4" />Follow</>
                                )}
                              </Button>
                            </div>

                            <ul className="space-y-2">
                              {sidShows.map((show) => (
                                <li
                                  key={show.pid}
                                  className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900/70 p-3"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate font-medium text-slate-100">{show.title}</p>
                                    <p className="text-xs text-slate-500">{formatDate(show.publishedAt)}{formatDuration(show) ? ` · ${formatDuration(show)}` : ""}{formatDateOnly(show.expiresAt) ? ` · expires ${formatDateOnly(show.expiresAt)}` : ""}</p>
                                    <SubtitleBadges show={show} />
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => openDownloadOptions(show, "web")}
                                      className="relative h-8 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
                                    >
                                      <span
                                        className="absolute bottom-0 left-0 h-1 bg-sky-200/50 transition-[width] duration-200"
                                        style={{ width: `${downloadProgress[show.pid] ?? 0}%` }}
                                      />
                                      <Download className="mr-2 h-4 w-4" />
                                      Download
                                    </Button>
                                    <Button variant="outline" size="sm" onClick={() => openDownloadOptions(show, "library")} className="h-8 border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700">Library</Button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </section>
                        ))}
                      </div>
                    </section>
                  ) : null,
                )}
              </div>
            ) : (
              <div>
                <div className="space-y-6">
                  {CONTENT_GROUP_ORDER.map((groupType) =>
                    groupType === contentFilter && categorizedPageShows[groupType].length > 0 ? (
                      <section key={groupType}>
                        <ul
                          className="poster-grid gap-4"
                          style={{ "--poster-columns": posterColumns } as CSSProperties}
                        >
                          {categorizedPageShows[groupType].map(([sid, sidShows]) => (
                            <li
                              key={sid}
                              className="group cursor-pointer transition-transform hover:-translate-y-0.5"
                              onClick={() => openDetailsPage(sid)}
                            >
                              <div className="relative aspect-2/3 overflow-hidden rounded-lg bg-slate-800">
                                {getGroupPosterUrl(sidShows) && !imageLoadFailed[sid] ? (
                                  <img
                                    src={getGroupPosterUrl(sidShows) ?? ""}
                                    alt={`${getGroupTitle(sidShows)} poster`}
                                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                                    loading="lazy"
                                    onError={() => setImageLoadFailed((current) => ({ ...current, [sid]: true }))}
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-xs font-medium text-slate-500">
                                    No image
                                  </div>
                                )}
                                {/* Follow bar — shown on hover, or always visible when already followed */}
                                <div
                                  className={`absolute inset-x-0 bottom-0 flex items-center justify-center bg-linear-to-t from-black/90 to-transparent px-2 pb-2 pt-6 transition-opacity duration-200 ${
                                    isSidFollowed(sidShows) ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                                  }`}
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <button
                                    onClick={() => void toggleFollowSid(sid, !isSidFollowed(sidShows))}
                                    className={`flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-semibold transition-colors ${
                                      isSidFollowed(sidShows)
                                        ? "bg-sky-600/90 text-sky-50 hover:bg-rose-600/90 hover:text-rose-50"
                                        : "bg-white/10 text-slate-100 backdrop-blur-sm hover:bg-white/20"
                                    }`}
                                  >
                                    {isSidFollowed(sidShows) ? (
                                      <>
                                        <Check className="h-3.5 w-3.5" />
                                        Following
                                      </>
                                    ) : (
                                      <>
                                        <Plus className="h-3.5 w-3.5" />
                                        Follow
                                      </>
                                    )}
                                  </button>
                                </div>
                              </div>
                              <div className="pt-2">
                                <p className="line-clamp-2 text-sm font-semibold text-slate-100">{getGroupTitle(sidShows)}</p>
                                {sidShows.length === 1 && formatDuration(sidShows[0]) ? <p className="mt-0.5 text-xs text-slate-500">{formatDuration(sidShows[0])}</p> : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null,
                  )}
                </div>
              </div>
            )}
          </div>

          {shows.length > 0 && !selectedSid ? (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-slate-400">
                Showing {pageStartIndex}–{pageEndIndex} of {totalItemsForView}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                  onClick={() => changePage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>
                <span className="text-sm text-slate-400">
                  {currentPage} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                  onClick={() => changePage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </main>

      {/* Per-download options */}
      {downloadChoice ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setDownloadChoice(null)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-slate-800 p-4">
              <p className="text-lg font-semibold text-slate-100">{downloadChoice.mode === "web" ? "Download to this computer" : "Download to library"}</p>
              <p className="mt-1 line-clamp-2 text-sm text-slate-400">{downloadChoice.shows.length === 1 ? downloadChoice.shows[0].title : `${downloadChoice.shows.length} episodes selected`}</p>
            </div>
            <div className="space-y-4 p-4">
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Languages className="h-4 w-4 text-sky-400" />
                  Subtitle files
                </div>
                <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                  <label className={`flex items-center gap-2 text-sm ${downloadChoice.shows.some((show) => show.subtitleLanguages?.includes("is")) ? "text-slate-200" : "text-slate-600"}`}>
                    <input
                      type="checkbox"
                      checked={selectedSubtitleLanguages.includes("is")}
                      disabled={!downloadChoice.shows.some((show) => show.subtitleLanguages?.includes("is"))}
                      onChange={(event) => setSelectedSubtitleLanguages((current) => event.target.checked ? [...current.filter((language) => language !== "is"), "is"] : current.filter((language) => language !== "is"))}
                    />
                    Icelandic {downloadChoice.shows.some((show) => show.subtitleLanguages?.includes("is")) ? "(selected by default where available)" : "(not available)"}
                  </label>
                  <label className={`flex items-center gap-2 text-sm ${downloadChoice.shows.some((show) => show.subtitleLanguages?.includes("en")) ? "text-slate-200" : "text-slate-600"}`}>
                    <input
                      type="checkbox"
                      checked={selectedSubtitleLanguages.includes("en")}
                      disabled={!downloadChoice.shows.some((show) => show.subtitleLanguages?.includes("en"))}
                      onChange={(event) => setSelectedSubtitleLanguages((current) => event.target.checked ? [...current.filter((language) => language !== "en"), "en"] : current.filter((language) => language !== "en"))}
                    />
                    English {downloadChoice.shows.some((show) => show.subtitleLanguages?.includes("en")) ? "(select explicitly; used where available)" : "(not available)"}
                  </label>
                </div>
                {downloadChoice.shows.some((show) => show.englishSubtitledVersion) ? (
                  <p className="mt-2 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-200">
                    This is RÚV's English-subtitled video version; its English subtitles are part of the picture.
                  </p>
                ) : null}
              </div>

              {downloadChoice.mode === "web" ? (
                <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                  <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
                    <FolderOpen className="h-4 w-4 text-sky-400" />
                    Save on this computer
                  </div>
                  <p className="text-xs leading-relaxed text-slate-500">
                    {folderPickerAvailable
                      ? defaultDownloadFolder
                        ? `Your remembered default is “${defaultDownloadFolder.name}”. You can also use the browser folder or choose another folder just this once.`
                        : "Use your browser's normal download folder, or choose a different folder specifically for this download. You can set a remembered default under Settings."
                      : "Direct folder selection is unavailable on this browser or connection. Use the browser download below and enable ‘Ask where to save’ in your browser if needed."}
                  </p>
                </div>
              ) : null}

              {downloadChoice.mode === "library" ? (
                <div className="rounded-lg border border-sky-700/40 bg-sky-950/20 p-3">
                  <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-200">
                    <FolderOpen className="h-4 w-4 text-sky-400" />
                    Configured library destination
                  </div>
                  <code className="block break-all rounded bg-slate-950 px-2 py-1.5 text-xs text-sky-200">{getLibraryDestination(settings, downloadChoice.shows)}</code>
                  <p className="mt-2 text-xs leading-relaxed text-slate-500">This uses the default folder for {downloadChoice.shows[0]?.contentType === "movie_or_docu" ? "movies and documentaries" : downloadChoice.shows[0]?.contentType === "sport" ? "sports" : "shows"}. Change it under Settings.</p>
                </div>
              ) : null}

              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                  onClick={() => setDownloadChoice(null)}
                >
                  Cancel
                </Button>
                {downloadChoice.mode === "web" ? (
                  <>
                    {defaultDownloadFolder ? (
                      <Button
                        className="bg-sky-600 text-white hover:bg-sky-500"
                        onClick={() => void downloadToDefaultFolder()}
                      >
                        <FolderOpen className="mr-2 h-4 w-4" />
                        Use {defaultDownloadFolder.name}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                      onClick={() => void handleDownloads(downloadChoice.shows, "web")}
                    >
                      Use browser folder
                    </Button>
                    <Button
                      disabled={!folderPickerAvailable}
                      className={defaultDownloadFolder ? "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700" : "bg-sky-600 text-white hover:bg-sky-500"}
                      variant={defaultDownloadFolder ? "outline" : "default"}
                      onClick={() => void chooseFolderAndDownload()}
                    >
                      <FolderOpen className="mr-2 h-4 w-4" />
                      Choose another folder
                    </Button>
                  </>
                ) : (
                  <Button
                    className="bg-sky-600 text-white hover:bg-sky-500"
                    onClick={() => void handleDownloads(downloadChoice.shows, "library")}
                  >
                    Download to library
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Settings modal */}
      {showAutomationSettings ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={() => setShowAutomationSettings(false)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 p-4">
              <div>
                <p className="text-lg font-semibold text-slate-100">Settings</p>
                <p className="text-sm text-slate-500">Configure watchlist automation and Plex integration.</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                onClick={() => setShowAutomationSettings(false)}
              >
                Close
              </Button>
            </div>

            <div className="max-h-[65vh] overflow-y-auto p-4">
              <div className="mb-4 rounded-lg border border-slate-700 bg-slate-950/50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-slate-200">Default folder for Download</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {folderPickerAvailable
                        ? defaultDownloadFolder
                          ? `Currently “${defaultDownloadFolder.name}”. This choice is stored securely by this browser on this computer.`
                          : "No app default selected. Downloads currently use the browser’s normal download folder."
                        : "This browser cannot remember a website folder. Its normal download-folder setting will be used instead."}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {defaultDownloadFolder ? (
                      <Button variant="outline" size="sm" className="border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700" onClick={() => void forgetDefaultDownloadFolder()}>Forget</Button>
                    ) : null}
                    <Button size="sm" disabled={!folderPickerAvailable} className="bg-sky-600 text-white hover:bg-sky-500" onClick={() => void chooseDefaultDownloadFolder()}>
                      <FolderOpen className="mr-2 h-4 w-4" />
                      {defaultDownloadFolder ? "Change folder" : "Choose folder"}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <Button
                  variant={settings.autoEnabled ? "default" : "outline"}
                  size="sm"
                  className={
                    settings.autoEnabled
                      ? "border border-emerald-500/70 bg-emerald-500/80 text-emerald-50 hover:bg-emerald-500"
                      : "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                  }
                  onClick={() => setSettings((current) => ({ ...current, autoEnabled: !current.autoEnabled }))}
                >
                  {settings.autoEnabled ? "Automation enabled" : "Automation disabled"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700"
                  onClick={() => void runAutoNow()}
                  disabled={autoStatus.isRunning}
                >
                  {autoStatus.isRunning ? "Auto running..." : "Run auto now"}
                </Button>
                <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-400">
                  Last run: {autoStatus.lastRunAt ? formatDate(autoStatus.lastRunAt) : "never"}
                </span>
                {autoStatus.lastRunMessage ? (
                  <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-400">
                    {autoStatus.lastRunMessage}
                  </span>
                ) : null}
              </div>

              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <Input
                  value={settings.libraryRootDir}
                  onChange={(event) => setSettings((current) => ({ ...current, libraryRootDir: event.target.value }))}
                  placeholder="Library root folder, e.g. /data/media/ruv"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  type="number"
                  value={String(settings.autoIntervalMinutes)}
                  onChange={(event) =>
                    setSettings((current) => ({
                      ...current,
                      autoIntervalMinutes: Math.max(5, Number(event.target.value) || 60),
                    }))
                  }
                  placeholder="Auto interval (minutes)"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  value={settings.showsSubdir}
                  onChange={(event) => setSettings((current) => ({ ...current, showsSubdir: event.target.value }))}
                  placeholder="Shows subfolder (under library root)"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  value={settings.moviesSubdir}
                  onChange={(event) => setSettings((current) => ({ ...current, moviesSubdir: event.target.value }))}
                  placeholder="Movies subfolder (under library root)"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  value={settings.sportsSubdir}
                  onChange={(event) => setSettings((current) => ({ ...current, sportsSubdir: event.target.value }))}
                  placeholder="Sports subfolder (under library root)"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  value={settings.plexBaseUrl}
                  onChange={(event) => setSettings((current) => ({ ...current, plexBaseUrl: event.target.value }))}
                  placeholder="Plex base URL, e.g. http://truenas:32400"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  value={settings.plexLibrarySectionId}
                  onChange={(event) =>
                    setSettings((current) => ({ ...current, plexLibrarySectionId: event.target.value }))
                  }
                  placeholder="Plex library section id"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  value={settings.plexToken}
                  onChange={(event) => setSettings((current) => ({ ...current, plexToken: event.target.value }))}
                  placeholder="Plex token"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
                <Input
                  value={settings.plexLibraryPath}
                  onChange={(event) => setSettings((current) => ({ ...current, plexLibraryPath: event.target.value }))}
                  placeholder="Optional Plex path filter"
                  className="h-9 border-slate-700 bg-slate-800 text-slate-100 placeholder:text-slate-500"
                />
              </div>
              <div className="mt-3">
                <Button
                  size="sm"
                  onClick={() => void saveSettings()}
                  disabled={isSavingSettings}
                  className="border border-slate-700 bg-slate-100 text-slate-900 hover:bg-white"
                >
                  {isSavingSettings ? "Saving..." : "Save settings"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {downloadJobs.length > 0 && isDownloadQueueOpen ? (
        <aside className="fixed bottom-4 right-4 z-40 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-slate-100">Download queue</p>
              <p className="text-xs text-slate-500">
                {downloadJobs.filter((job) => ["queued", "downloading", "processing"].includes(job.status)).length} active or waiting · {downloadJobs.filter((job) => ["completed", "failed", "cancelled"].includes(job.status)).length} finished
              </p>
            </div>
            <div className="flex items-center gap-1">
              {downloadJobs.some((job) => ["completed", "failed", "cancelled"].includes(job.status)) ? (
                <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100" onClick={() => void clearFinishedDownloadJobs()}>Clear finished</Button>
              ) : null}
              <Button variant="ghost" size="sm" aria-label="Close download queue" title="Close; downloads continue in the background" className="h-8 w-8 p-0 text-slate-400 hover:bg-slate-800 hover:text-slate-100" onClick={() => setIsDownloadQueueOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto p-3">
            {downloadJobs.slice(0, 8).map((job) => (
              <div key={job.id} className="rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-100">{job.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${job.status === "completed" ? "bg-emerald-500/15 text-emerald-300" : job.status === "failed" ? "bg-rose-500/15 text-rose-300" : job.status === "cancelled" ? "bg-slate-700 text-slate-300" : job.status === "queued" ? "bg-amber-500/15 text-amber-300" : "bg-sky-500/15 text-sky-300"}`}>
                        {job.status === "queued" ? "Waiting" : job.status === "processing" ? "Finishing" : job.status.charAt(0).toUpperCase() + job.status.slice(1)}
                      </span>
                      <span className="text-xs text-slate-400">{job.stage} · {Math.round(job.progress)}%</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {job.status === "failed" || job.status === "cancelled" ? (
                      <Button variant="outline" size="sm" className="h-7 border-sky-800/70 bg-sky-950/40 px-2 text-xs text-sky-200 hover:bg-sky-900/60" onClick={() => void retryDownloadJob(job)}>Retry</Button>
                    ) : null}
                    {job.status === "queued" || job.status === "downloading" || job.status === "processing" ? (
                      <Button variant="outline" size="sm" className="h-7 border-rose-800/70 bg-rose-950/40 px-2 text-xs text-rose-200 hover:bg-rose-900/60" onClick={() => void cancelDownloadJob(job.id)}>Stop</Button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className={`h-full transition-[width] duration-300 ${job.status === "failed" ? "bg-rose-500" : job.status === "cancelled" ? "bg-slate-500" : "bg-sky-500"}`} style={{ width: `${job.progress}%` }} />
                </div>
                {job.status === "failed" ? <p className="mt-1 text-xs text-rose-300">{job.message || "The download failed. You can retry it."}</p> : null}
                {job.status === "cancelled" ? <p className="mt-1 text-xs text-slate-500">Stopped before completion.</p> : null}
                {job.status === "completed" ? <p className="mt-1 text-xs text-emerald-400/80">Download completed successfully.</p> : null}
              </div>
            ))}
          </div>
        </aside>
      ) : null}

      {downloadJobs.length > 0 && !isDownloadQueueOpen ? (
        <Button
          className="fixed bottom-4 right-4 z-40 bg-sky-600 text-white shadow-xl hover:bg-sky-500"
          onClick={() => setIsDownloadQueueOpen(true)}
        >
          <Download className="mr-2 h-4 w-4" />
          Downloads ({downloadJobs.filter((job) => ["queued", "downloading", "processing"].includes(job.status)).length || downloadJobs.length})
        </Button>
      ) : null}

    </div>
  );
}
