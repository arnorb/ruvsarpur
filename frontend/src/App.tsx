// frontend/src/App.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type ShowItem = {
  pid: string;
  sid: string;
  title: string;
  seriesTitle: string;
  publishedAt: string;
  posterUrl?: string | null;
  isFollowed?: boolean;
};

type AutoSettings = {
  watchlistSids: string[];
  autoEnabled: boolean;
  autoIntervalMinutes: number;
  outputDir: string;
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
  return sidShows.find((show) => !!show.posterUrl)?.posterUrl ?? null;
}

function isSidFollowed(sidShows: ShowItem[]): boolean {
  return sidShows.some((show) => show.isFollowed);
}

export default function App() {
  const [query, setQuery] = useState("");
  const [shows, setShows] = useState<ShowItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDownloading, setIsDownloading] = useState<string | null>(null);
  const [refreshProgress, setRefreshProgress] = useState(0);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [viewMode, setViewMode] = useState<"list" | "poster">("list");
  const [selectedSid, setSelectedSid] = useState<string | null>(null);
  const [imageLoadFailed, setImageLoadFailed] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState<AutoSettings>({
    watchlistSids: [],
    autoEnabled: false,
    autoIntervalMinutes: 60,
    outputDir: "",
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
  const totalPages = useMemo(() => Math.max(1, Math.ceil(shows.length / PAGE_SIZE)), [shows.length]);
  const paginatedShows = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    return shows.slice(start, end);
  }, [shows, currentPage]);
  const pageStartIndex = useMemo(() => (shows.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1), [shows.length, currentPage]);
  const pageEndIndex = useMemo(
    () => Math.min(currentPage * PAGE_SIZE, shows.length),
    [currentPage, shows.length],
  );
  const groupedPageShows = useMemo(() => {
    const grouped: Record<string, ShowItem[]> = {};
    for (const show of paginatedShows) {
      if (!grouped[show.sid]) grouped[show.sid] = [];
      grouped[show.sid].push(show);
    }
    return Object.entries(grouped);
  }, [paginatedShows]);
  const episodesForSelectedSid = useMemo(() => {
    if (!selectedSid) return [];
    return shows
      .filter((show) => show.sid === selectedSid)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }, [selectedSid, shows]);
  const selectedSidFollowed = useMemo(() => {
    if (!selectedSid) return false;
    return shows.some((show) => show.sid === selectedSid && show.isFollowed);
  }, [selectedSid, shows]);

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
      const data = (await response.json()) as { shows?: ShowItem[]; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Failed to fetch shows");
      }
      setShows(data.shows ?? []);
      setCurrentPage(1);
      setSelectedSid(null);
      setImageLoadFailed({});
      setStatusMessage(`Loaded ${data.shows?.length ?? 0} show(s).`);
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
      const data = (await response.json()) as { settings?: AutoSettings; status?: AutoStatus; error?: string };
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
      const data = (await response.json()) as { settings?: AutoSettings; error?: string };
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
      const data = (await response.json()) as { status?: AutoStatus; error?: string };
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
      const data = (await response.json()) as { message?: string; error?: string };
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

  const toggleFollowSid = async (sid: string, follow: boolean) => {
    setErrorMessage("");
    try {
      if (follow) {
        const response = await fetch(`${API_BASE_URL}/api/watchlist`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid }),
        });
        const data = (await response.json()) as { watchlistSids?: string[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Failed to follow series");
        setSettings((current) => ({ ...current, watchlistSids: data.watchlistSids ?? current.watchlistSids }));
      } else {
        const response = await fetch(`${API_BASE_URL}/api/watchlist?sid=${encodeURIComponent(sid)}`, {
          method: "DELETE",
        });
        const data = (await response.json()) as { watchlistSids?: string[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? "Failed to unfollow series");
        setSettings((current) => ({ ...current, watchlistSids: data.watchlistSids ?? current.watchlistSids }));
      }
      setFollowStateForSid(sid, follow);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while updating watchlist";
      setErrorMessage(message);
    }
  };

  const handleDownload = async (show: ShowItem) => {
    setErrorMessage("");
    setIsDownloading(show.pid);
    setStatusMessage(`Downloading ${show.title}...`);
    startDownloadTicker(show.pid);
    try {
      const response = await fetch(`${API_BASE_URL}/api/download`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid: show.pid }),
      });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? "Download failed");
      }
      setStatusMessage(data.message ?? `Downloaded ${show.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error while downloading";
      setErrorMessage(message);
      setStatusMessage("");
    } finally {
      stopDownloadTicker(show.pid);
      setIsDownloading(null);
    }
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
    return () => {
      if (refreshTickerRef.current !== null) window.clearInterval(refreshTickerRef.current);
      for (const pid in downloadTickerRef.current) {
        window.clearInterval(downloadTickerRef.current[pid]);
      }
    };
  }, []);

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>RUV Sarpur GUI</CardTitle>
          <CardDescription>Refresh, search, and download directly through the Python backend API.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row">
            <Button
              onClick={() => void loadShows(true)}
              disabled={isLoading}
              className="relative overflow-hidden md:w-40"
            >
              <span
                className="absolute bottom-0 left-0 h-1 bg-slate-100/40 transition-[width] duration-200"
                style={{ width: `${refreshProgress}%` }}
              />
              <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              {isLoading ? `Refreshing ${Math.round(refreshProgress)}%` : "Refresh list"}
            </Button>

            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-500" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by title or ID"
                className="pl-9"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void loadShows(false);
                }}
              />
            </div>

            <Button onClick={() => void loadShows(false)} variant="outline" disabled={isLoading}>
              Search
            </Button>

            <div className="flex items-center gap-2">
              <Button
                onClick={() => setViewMode("list")}
                variant={viewMode === "list" ? "default" : "outline"}
                disabled={isLoading}
              >
                List view
              </Button>
              <Button
                onClick={() => setViewMode("poster")}
                variant={viewMode === "poster" ? "default" : "outline"}
                disabled={isLoading}
              >
                Poster view
              </Button>
            </div>
          </div>

          {statusMessage ? <p className="text-sm text-slate-600">{statusMessage}</p> : null}
          {errorMessage ? <p className="text-sm text-red-600">{errorMessage}</p> : null}

          <div className="rounded-md border border-slate-200 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Button
                variant={settings.autoEnabled ? "default" : "outline"}
                size="sm"
                onClick={() => setSettings((current) => ({ ...current, autoEnabled: !current.autoEnabled }))}
              >
                {settings.autoEnabled ? "Auto enabled" : "Auto disabled"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void runAutoNow()} disabled={autoStatus.isRunning}>
                {autoStatus.isRunning ? "Auto running..." : "Run auto now"}
              </Button>
              <span className="text-xs text-slate-500">
                Last run: {autoStatus.lastRunAt ? formatDate(autoStatus.lastRunAt) : "never"}
              </span>
              {autoStatus.lastRunMessage ? (
                <span className="text-xs text-slate-500">{autoStatus.lastRunMessage}</span>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <Input
                value={settings.outputDir}
                onChange={(event) => setSettings((current) => ({ ...current, outputDir: event.target.value }))}
                placeholder="Output folder for downloads"
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
              />
              <Input
                value={settings.plexBaseUrl}
                onChange={(event) => setSettings((current) => ({ ...current, plexBaseUrl: event.target.value }))}
                placeholder="Plex base URL, e.g. http://truenas:32400"
              />
              <Input
                value={settings.plexLibrarySectionId}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, plexLibrarySectionId: event.target.value }))
                }
                placeholder="Plex library section id"
              />
              <Input
                value={settings.plexToken}
                onChange={(event) => setSettings((current) => ({ ...current, plexToken: event.target.value }))}
                placeholder="Plex token"
              />
              <Input
                value={settings.plexLibraryPath}
                onChange={(event) => setSettings((current) => ({ ...current, plexLibraryPath: event.target.value }))}
                placeholder="Optional Plex path filter"
              />
            </div>
            <div className="mt-2">
              <Button size="sm" onClick={() => void saveSettings()} disabled={isSavingSettings}>
                {isSavingSettings ? "Saving..." : "Save automation settings"}
              </Button>
            </div>
          </div>

          <div className="rounded-md border border-slate-200">
            {shows.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">
                {hasQuery ? "No results for your search." : "No shows returned from backend."}
              </p>
            ) : viewMode === "list" ? (
              <div className="divide-y divide-slate-200">
                {groupedPageShows.map(([sid, sidShows]) => (
                  <section key={sid} className="p-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">
                          SID {sid} - {getGroupTitle(sidShows)}
                        </p>
                        <p className="text-xs text-slate-500">{sidShows.length} show(s) on this page</p>
                      </div>
                      <Button
                        size="sm"
                        variant={isSidFollowed(sidShows) ? "default" : "outline"}
                        onClick={() => void toggleFollowSid(sid, !isSidFollowed(sidShows))}
                      >
                        {isSidFollowed(sidShows) ? "Following" : "Follow"}
                      </Button>
                    </div>

                    <ul className="space-y-3">
                      {sidShows.map((show) => (
                        <li key={show.pid} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <div className="min-w-0">
                              <p className="truncate font-medium text-slate-900">{show.title}</p>
                              <p className="text-sm text-slate-500">
                                PID {show.pid} - {formatDate(show.publishedAt)}
                              </p>
                            </div>
                          </div>

                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => void handleDownload(show)}
                            disabled={isDownloading !== null}
                            className="relative overflow-hidden"
                          >
                            <span
                              className="absolute bottom-0 left-0 h-1 bg-slate-300 transition-[width] duration-200"
                              style={{ width: `${downloadProgress[show.pid] ?? 0}%` }}
                            />
                            <Download className="mr-2 h-4 w-4" />
                            {isDownloading === show.pid
                              ? `Downloading ${Math.round(downloadProgress[show.pid] ?? 0)}%`
                              : "Download"}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ) : (
              <div className="p-4">
                <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {groupedPageShows.map(([sid, sidShows]) => (
                    <li
                      key={sid}
                      className="cursor-pointer rounded-md border border-slate-200 p-3 transition-colors hover:bg-slate-50"
                      onClick={() => setSelectedSid(sid)}
                    >
                      <div className="mx-auto mb-3 h-[210px] w-[140px] overflow-hidden rounded border border-slate-200 bg-slate-100">
                        {getGroupPosterUrl(sidShows) && !imageLoadFailed[sid] ? (
                          <img
                            src={getGroupPosterUrl(sidShows) ?? ""}
                            alt={`${getGroupTitle(sidShows)} poster`}
                            className="h-full w-full object-cover"
                            loading="lazy"
                            onError={() => setImageLoadFailed((current) => ({ ...current, [sid]: true }))}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs font-medium text-slate-500">
                            Placeholder
                          </div>
                        )}
                      </div>
                      <p className="line-clamp-2 text-sm font-medium text-slate-900">{getGroupTitle(sidShows)}</p>
                      <p className="text-xs text-slate-500">{sidShows.length} episode(s) on this page</p>
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant={isSidFollowed(sidShows) ? "default" : "outline"}
                          className="w-full"
                          onClick={(event) => {
                            event.stopPropagation();
                            void toggleFollowSid(sid, !isSidFollowed(sidShows));
                          }}
                        >
                          {isSidFollowed(sidShows) ? "Following" : "Follow"}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {shows.length > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-slate-600">
                Showing {pageStartIndex}-{pageEndIndex} of {shows.length}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </Button>
                <span className="text-sm text-slate-600">
                  Page {currentPage} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                  disabled={currentPage === totalPages}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {selectedSid ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSelectedSid(null)}
        >
          <div
            className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-lg bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-200 p-4">
              <div>
                <p className="text-lg font-semibold text-slate-900">
                  {getGroupTitle(episodesForSelectedSid)}
                </p>
                <p className="text-sm text-slate-500">SID {selectedSid}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={selectedSidFollowed ? "default" : "outline"}
                  onClick={() => {
                    if (!selectedSid) return;
                    void toggleFollowSid(selectedSid, !selectedSidFollowed);
                  }}
                >
                  {selectedSidFollowed ? "Following" : "Follow"}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setSelectedSid(null)}>
                  Close
                </Button>
              </div>
            </div>
            <div className="max-h-[65vh] overflow-y-auto p-4">
              {episodesForSelectedSid.length === 0 ? (
                <p className="text-sm text-slate-500">No episodes found for this series.</p>
              ) : (
                <ul className="space-y-2">
                  {episodesForSelectedSid.map((episode) => (
                    <li
                      key={episode.pid}
                      className="flex items-center justify-between gap-3 rounded-md border border-slate-200 p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900">{episode.title}</p>
                        <p className="text-sm text-slate-500">
                          PID {episode.pid} - {formatDate(episode.publishedAt)}
                        </p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleDownload(episode)}
                        disabled={isDownloading !== null}
                        className="relative overflow-hidden"
                      >
                        <span
                          className="absolute bottom-0 left-0 h-1 bg-slate-300 transition-[width] duration-200"
                          style={{ width: `${downloadProgress[episode.pid] ?? 0}%` }}
                        />
                        <Download className="mr-2 h-4 w-4" />
                        {isDownloading === episode.pid
                          ? `Downloading ${Math.round(downloadProgress[episode.pid] ?? 0)}%`
                          : "Download"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
