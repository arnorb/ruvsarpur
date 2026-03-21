// frontend/src/App.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Clapperboard, Download, Film, Plus, RefreshCw, Search, Settings, Tv, Volleyball } from "lucide-react";
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
  webUrl?: string;
  posterUrl?: string | null;
  isFollowed?: boolean;
  contentType?: "movie_or_docu" | "sport" | "show";
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

export default function App() {
  const navigate = useNavigate();
  const { sid: routeSid } = useParams<{ sid?: string }>();
  const selectedSid = routeSid ?? null;
  const [query, setQuery] = useState("");
  const [shows, setShows] = useState<ShowItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState<string | null>(null);
  const [refreshProgress, setRefreshProgress] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [viewMode, setViewMode] = useState<"list" | "poster">("poster");
  const [contentFilter, setContentFilter] = useState<"movie_or_docu" | "sport" | "show">("show");
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
  const refreshTickerRef = useRef<number | null>(null);
  const downloadTickerRef = useRef<Record<string, number>>({});

  const hasQuery = useMemo(() => query.trim().length > 0, [query]);
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

  const filteredGroupedAllShows = useMemo(
    () => groupedAllShows.filter((group) => getGroupContentType(group[1]) === contentFilter),
    [groupedAllShows, contentFilter],
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

  const startRefreshTicker = () => {
    if (refreshTickerRef.current !== null) window.clearInterval(refreshTickerRef.current);
    setRefreshProgress(8);
    refreshTickerRef.current = window.setInterval(() => {
      setRefreshProgress((current) => (current >= 90 ? current : Math.min(90, current + 6)));
    }, 250);
  };

  const stopRefreshTicker = () => {
    if (refreshTickerRef.current !== null) {
      window.clearInterval(refreshTickerRef.current);
      refreshTickerRef.current = null;
    }
    setRefreshProgress(100);
    window.setTimeout(() => setRefreshProgress(0), 350);
  };

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

  const loadShows = async (refresh: boolean) => {
    setIsLoading(true);
    setErrorMessage("");
    setStatusMessage(refresh ? "Refreshing list..." : "Loading list...");
    startRefreshTicker();
    try {
      const queryParam = encodeURIComponent(query.trim());
      const response = await fetch(`${API_BASE_URL}/api/shows?query=${queryParam}&refresh=${refresh ? "1" : "0"}`);
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
      stopRefreshTicker();
    }
  };

  const loadSettings = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/settings`);
      const data = await parseApiResponse<{ settings?: AutoSettings; status?: AutoStatus; error?: string }>(response);
      if (!response.ok) throw new Error(data.error ?? "Failed to load settings");
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

  const handleDownload = async (show: ShowItem, mode: "web" | "library") => {
    setErrorMessage("");
    setIsDownloading(show.pid);
    setStatusMessage(`${mode === "web" ? "Web" : "Library"} downloading ${show.title}...`);
    startDownloadTicker(show.pid);
    try {
      const response = await fetch(`${API_BASE_URL}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: show.pid, mode, contentType: show.contentType ?? "show" }),
      });
      const data = await parseApiResponse<{
        message?: string;
        error?: string;
        outputDir?: string;
        downloadUrl?: string;
        fileName?: string;
      }>(response);
      if (!response.ok) {
        throw new Error(data.error ?? "Download failed");
      }
      const suffix = data.outputDir ? ` (${data.outputDir})` : "";
      setStatusMessage((data.message ?? `Downloaded ${show.title}`) + suffix);
      if (mode === "web" && data.downloadUrl) {
        const href = data.downloadUrl.startsWith("http") ? data.downloadUrl : `${API_BASE_URL}${data.downloadUrl}`;
        const downloadAnchor = document.createElement("a");
        downloadAnchor.href = href;
        if (data.fileName) downloadAnchor.download = data.fileName;
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        document.body.removeChild(downloadAnchor);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while downloading";
      setErrorMessage(message);
      setStatusMessage("");
    } finally {
      stopDownloadTicker(show.pid);
      setIsDownloading(null);
    }
  };

  const handleWebOpen = (show: ShowItem) => {
    const targetUrl = show.webUrl && show.webUrl.length > 0 ? show.webUrl : "https://www.ruv.is/sjonvarp";
    window.open(targetUrl, "_blank", "noopener,noreferrer");
  };

  useEffect(() => {
    void loadShows(false);
    void loadSettings();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchAutoStatus();
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setCurrentPage(1);
  }, [contentFilter]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  useEffect(() => {
    return () => {
      if (refreshTickerRef.current !== null) window.clearInterval(refreshTickerRef.current);
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

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">

      {/* Left sidebar */}
      <aside className="sticky top-0 flex h-screen w-44 shrink-0 flex-col border-r border-slate-800 bg-slate-900/80 py-4 px-3">
        {/* Logo */}
        <div className="mb-6 flex items-center gap-2">
          <Clapperboard className="h-6 w-6 shrink-0 text-sky-400" />
          <span className="text-base font-bold tracking-tight text-slate-100">RÚV Sarpur</span>
        </div>

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
            onClick={() => void loadShows(true)}
            disabled={isLoading}
            size="sm"
            className="relative h-9 shrink-0 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
          >
            <span
              className="absolute bottom-0 left-0 h-1 bg-sky-200/40 transition-[width] duration-200"
              style={{ width: `${refreshProgress}%` }}
            />
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            {isLoading ? `${Math.round(refreshProgress)}%` : "Refresh"}
          </Button>
        </header>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-4 md:p-6">
          {statusMessage ? (
            <p className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              {statusMessage}
            </p>
          ) : null}
          {errorMessage ? (
            <p className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {errorMessage}
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
                        <p className="text-sm text-slate-500">Air date: {formatDate(selectedPrimaryItem.publishedAt)}</p>
                        {getEpisodeDescription(selectedPrimaryItem) ? (
                          <p className="text-sm leading-relaxed text-slate-300">
                            {getEpisodeDescription(selectedPrimaryItem)}
                          </p>
                        ) : null}
                        <div className="flex items-center gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleDownload(selectedPrimaryItem, "web")}
                            disabled={isDownloading !== null}
                            className="relative h-8 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
                          >
                            <span
                              className="absolute bottom-0 left-0 h-1 bg-sky-200/50 transition-[width] duration-200"
                              style={{ width: `${downloadProgress[selectedPrimaryItem.pid] ?? 0}%` }}
                            />
                            <Download className="mr-2 h-4 w-4" />
                            {isDownloading === selectedPrimaryItem.pid ? "Downloading..." : "Download"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void handleDownload(selectedPrimaryItem, "library")}
                            disabled={isDownloading !== null}
                            className="relative h-7 border-slate-700 bg-slate-800 px-2 text-xs text-slate-200 hover:bg-slate-700"
                          >
                            <span
                              className="absolute bottom-0 left-0 h-1 bg-sky-500/60 transition-[width] duration-200"
                              style={{ width: `${downloadProgress[selectedPrimaryItem.pid] ?? 0}%` }}
                            />
                            {isDownloading === selectedPrimaryItem.pid ? "..." : "Library"}
                          </Button>
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
                      <ul className="space-y-2">
                        {episodesForSelectedSid.map((episode) => (
                          <li
                            key={episode.pid}
                            className="flex items-center justify-between gap-3 rounded-md border border-slate-800 bg-slate-900/70 p-3"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium text-slate-100">{episode.title}</p>
                              <p className="text-sm text-slate-500">{formatDate(episode.publishedAt)}</p>
                              {getEpisodeDescription(episode) ? (
                                <p className="mt-1 line-clamp-3 text-sm text-slate-300">{getEpisodeDescription(episode)}</p>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => void handleDownload(episode, "web")}
                                disabled={isDownloading !== null}
                                className="relative h-8 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
                              >
                                <span
                                  className="absolute bottom-0 left-0 h-1 bg-sky-200/50 transition-[width] duration-200"
                                  style={{ width: `${downloadProgress[episode.pid] ?? 0}%` }}
                                />
                                <Download className="mr-2 h-4 w-4" />
                                {isDownloading === episode.pid ? "Downloading..." : "Download"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => void handleDownload(episode, "library")}
                                disabled={isDownloading !== null}
                                className="relative h-7 border-slate-700 bg-slate-800 px-2 text-xs text-slate-200 hover:bg-slate-700"
                              >
                                <span
                                  className="absolute bottom-0 left-0 h-1 bg-sky-500/60 transition-[width] duration-200"
                                  style={{ width: `${downloadProgress[episode.pid] ?? 0}%` }}
                                />
                                {isDownloading === episode.pid ? "..." : "Library"}
                              </Button>
                            </div>
                          </li>
                        ))}
                      </ul>
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
                                    <p className="text-xs text-slate-500">{formatDate(show.publishedAt)}</p>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="secondary"
                                      size="sm"
                                      onClick={() => void handleDownload(show, "web")}
                                      disabled={isDownloading !== null}
                                      className="relative h-8 overflow-hidden border border-sky-600/60 bg-sky-600/90 text-sky-50 hover:bg-sky-500"
                                    >
                                      <span
                                        className="absolute bottom-0 left-0 h-1 bg-sky-200/50 transition-[width] duration-200"
                                        style={{ width: `${downloadProgress[show.pid] ?? 0}%` }}
                                      />
                                      <Download className="mr-2 h-4 w-4" />
                                      {isDownloading === show.pid ? "Downloading..." : "Download"}
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => void handleDownload(show, "library")}
                                      disabled={isDownloading !== null}
                                      className="relative h-7 border-slate-700 bg-slate-800 px-2 text-xs text-slate-200 hover:bg-slate-700"
                                    >
                                      <span
                                        className="absolute bottom-0 left-0 h-1 bg-sky-500/60 transition-[width] duration-200"
                                        style={{ width: `${downloadProgress[show.pid] ?? 0}%` }}
                                      />
                                      {isDownloading === show.pid ? "..." : "Library"}
                                    </Button>
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
                        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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

    </div>
  );
}
