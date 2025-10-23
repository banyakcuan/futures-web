"use client";

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { motion } from "framer-motion";

// shadcn/ui
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";

// icons
import { TrendingUp, TrendingDown, Settings, Search, ShieldAlert } from "lucide-react";

/* =========================================
   CONFIG
========================================= */
const BINANCE_FAPI = "https://fapi.binance.com";
const WS_BASE = "wss://fstream.binance.com/stream?streams=";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "1d"] as const;
type TF = (typeof TIMEFRAMES)[number];

const ROUND_ROBIN_DELAY = 2000; // ms
const MAX_STREAMS_PER_CONN = 120;

const TOP_N_DEFAULT = 10;

// D1 sebagai sumber Top Gainer/Loser
const USE_TOPN_SOURCE_TF: TF = "1d";
const TOPN_SOURCE_LIMIT = 50;

const USE_MA_FILTER_DEFAULT = true;
const MA_FILTER_TF: TF = "5m";
const MA_FILTER_LEN_DEFAULT = 50;

const USE_HIGH_GUARD_DEFAULT = true;
const NEAR_HIGH_THRESH_DEFAULT = -0.25;
const PUMP_MIN_SEQ_DEFAULT = 3;

const ALERT_SIGNALS = new Set(["STRONG BUY", "STRONG SELL"]);
const ALERT_MIN_TFS: TF[] = ["5m", "15m", "1h", "1d"];
const ALERT_EDIT_INTERVAL_SEC_DEFAULT = 4;
const ALERT_SL_TF: TF = "1m";
const ALERT_SL_LEN_DEFAULT = 15;

const LIMIT_SYMBOLS_DEFAULT = 0;

/* =========================================
   TABLE LAYOUT
========================================= */
const SYMBOL_WIDTH = 10;
const NOW_WIDTH = 7;
const OFFHIGH_WIDTH = 9;
const FORECAST_WIDTH = 16;
const EMOJI_CELL_WIDTH = 2;
const CSTRIP_EMOJI_COUNT = 5;
const CSTRIP_CELLS = EMOJI_CELL_WIDTH * CSTRIP_EMOJI_COUNT; // 10 cell
const UP_EMOJI = "🟩", DOWN_EMOJI = "🟥", FLAT_EMOJI = "⬜";

/* =========================================
   TYPES
========================================= */
type ByTf<T> = Partial<Record<TF, Record<string, T>>>;

interface SettingsState {
  topN: number;
  limitSymbols?: number;
  excludeLosersFromDisplay: boolean;
  useMAFilter: boolean;
  maLen: number;
  useHighGuard: boolean;
  nearHighThresh: number;
  pumpMinSeq: number;
  showSLinScreener: boolean;
  alertEditIntervalSec: number;
  alertSLlen: number;
}

interface AlertState {
  key: string; // ALERT|SYM|TF|SIG
  sym: string;
  tf: TF;
  sig: "STRONG BUY" | "STRONG SELL";
  firstSeen: number;
  lastEdit: number;
  entry: number;
  trailSL?: number;
  active: boolean;
  closed: boolean;
  exitPrice?: number;
  plPct?: number;
}

type Ticker24h = {
  quoteVolume: number;           // USDT volume
  priceChangePercent: number;    // 24h %
};

/* =========================================
   UTILS
========================================= */
const num = (v: unknown, d = 0): number => (typeof v === "number" && isFinite(v) ? v : d);

const priceDigitsFromTick = (tick: number) => {
  const s = tick.toFixed(16).replace(/0+$/g, "");
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
};

const fitSym = (s: string, width = SYMBOL_WIDTH) =>
  s.length > width ? s.slice(0, width - 1) + "…" : s.padEnd(width);

const pctText = (v: unknown, width: number) => {
  const vv = num(v);
  const sign = vv >= 0 ? "+" : "";
  return `${sign}${vv.toFixed(2).padStart(width + (vv >= 0 ? 0 : 1))}%`;
};

const nowPctText = (v: unknown) => pctText(v, NOW_WIDTH);
const offHighPctText = (v: unknown) => pctText(v, OFFHIGH_WIDTH);
const fmtPrice = (p: unknown, d = 4) => num(p).toFixed(Math.max(0, d));

const cbox = (v?: number | null) => (v == null ? FLAT_EMOJI : v > 0 ? UP_EMOJI : v < 0 ? DOWN_EMOJI : FLAT_EMOJI);
const cbarCompact = (c5?: number|null,c4?:number|null,c3?:number|null,c2?:number|null,c1?:number|null) =>
  `${cbox(c5)}${cbox(c4)}${cbox(c3)}${cbox(c2)}${cbox(c1)}`;

const cstripDisplayWidth = (s: string) => (s.match(/[🟩🟥⬜]/g)?.length ?? 0) * EMOJI_CELL_WIDTH;
const padCstripToCells = (s: string, targetCells: number) => s + " ".repeat(Math.max(0, targetCells - cstripDisplayWidth(s)));

const emaNext = (prev: number | undefined, price: number, len: number) =>
  prev == null ? price : (2 / (len + 1)) * price + (1 - 2 / (len + 1)) * prev;

function baseForecastFromChanges(changes: Array<number | null | undefined>): string {
  const arr = changes.filter((x): x is number => typeof x === "number" && isFinite(x));
  if (arr.length < 3) return "NEUTRAL";
  const positives = arr.filter((c) => c > 0).length;
  const negatives = arr.filter((c) => c < 0).length;
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  const last = arr[arr.length - 1];
  const L = arr.length;
  const a = L >= 3 ? arr[L - 3] : 0, b = L >= 2 ? arr[L - 2] : 0, c = L >= 1 ? arr[L - 1] : 0;
  const absAvg = arr.reduce((acc, v) => acc + Math.abs(v), 0) / arr.length;

  if (positives === arr.length && avg > 0.2) return "STRONG BUY";
  if (positives >= 4 && avg > 0) return "BUY";
  if (negatives === arr.length && avg < -0.2) return "STRONG SELL";
  if (negatives >= 4 && avg < 0) return "SELL";
  if (negatives >= 4 && last > 3) return "REVERSAL BUY";
  if (positives >= 4 && last < -3) return "REVERSAL SELL";
  if (absAvg <= 0.2) return "SIDEWAY";
  if (absAvg > 2.5 && positives > 0 && negatives > 0) return "VOLATILE";
  if (a < b && b < c && c > 0) return "MOMENTUM BUY";
  if (a > b && b > c && c < 0) return "MOMENTUM SELL";
  return "NEUTRAL";
}

// getNum overload: 1-level (map[sym]) atau 2-level (byTF[tf][sym])
function getNum(m: Record<string, number> | undefined, k: string, d?: number): number;
function getNum(m: Record<string, Record<string, number>> | undefined, tf: string, k: string, d?: number): number;
function getNum(m: any, a: any, b?: any, d: number = 0): number {
  if (typeof b === "string") { // bentuk 2-level
    const inner = (m?.[a] ?? {}) as Record<string, number>;
    return num(inner?.[b], d);
  }
  return num((m as Record<string, number> | undefined)?.[a], d);
}

// helper warna persen (hijau utk +, merah utk -)
function posNegClass(v?: number) {
  const n = num(v, 0);
  return n > 0 ? "text-emerald-600" : n < 0 ? "text-rose-600" : "text-muted-foreground";
}
function fmtPct(v?: number) {
  const n = num(v, 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
// warna forecast
function forecastTone(sig: string) {
  if (sig.includes("STRONG BUY")) return "text-emerald-700";
  if (sig.includes("BUY")) return "text-emerald-600";
  if (sig.includes("STRONG SELL")) return "text-rose-700";
  if (sig.includes("SELL")) return "text-rose-600";
  if (sig.includes("TOO HIGH")) return "text-amber-700";
  if (sig.includes("DONT")) return "text-muted-foreground";
  return "text-foreground";
}

/* =========================================
   STORE (Realtime, WS, Alerts, 24h ticker)
========================================= */
function useRealtimeStore() {
  const nowLive = useRef<ByTf<number>>({});
  const offHigh = useRef<ByTf<number>>({});
  const lastPrice = useRef<ByTf<number>>({});
  const lastHigh = useRef<ByTf<number>>({});
  const lastLow = useRef<ByTf<number>>({});
  const historyClosed = useRef<ByTf<number[]>>({});
  const emaCache = useRef<Record<string, Record<string, Record<number, number>>>>({});
  const priceDigits = useRef<Record<string, number>>({});
  const symbolOnboard = useRef<Record<string, number>>({});
  const allSymbols = useRef<string[]>([]);

  const ticker24h = useRef<Record<string, Ticker24h>>({}); // UPPER -> 24h stats

  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);

  const [settings, setSettings] = useState<SettingsState>({
    topN: TOP_N_DEFAULT,
    limitSymbols: LIMIT_SYMBOLS_DEFAULT,
    excludeLosersFromDisplay: true,
    useMAFilter: USE_MA_FILTER_DEFAULT,
    maLen: MA_FILTER_LEN_DEFAULT,
    useHighGuard: USE_HIGH_GUARD_DEFAULT,
    nearHighThresh: NEAR_HIGH_THRESH_DEFAULT,
    pumpMinSeq: PUMP_MIN_SEQ_DEFAULT,
    showSLinScreener: false,
    alertEditIntervalSec: ALERT_EDIT_INTERVAL_SEC_DEFAULT,
    alertSLlen: ALERT_SL_LEN_DEFAULT,
  });

  const alertsRef = useRef<Record<string, AlertState>>({});

  const ensureTfMap = (ref: React.MutableRefObject<ByTf<any>>, tf: TF) => {
    if (!ref.current[tf]) ref.current[tf] = {};
    return ref.current[tf]!;
    };
  const ensureEma = (tf: TF, sym: string, len: number) => {
    if (!emaCache.current[tf]) emaCache.current[tf] = {};
    if (!emaCache.current[tf][sym]) emaCache.current[tf][sym] = {};
    if (emaCache.current[tf][sym][len] == null) emaCache.current[tf][sym][len] = undefined as any;
    return emaCache.current[tf][sym];
  };

  const fetchExchangeInfo = useCallback(async () => {
    try {
      const res = await fetch(`${BINANCE_FAPI}/fapi/v1/exchangeInfo`);
      const info = await res.json();
      const syms: string[] = [];
      const digits: Record<string, number> = {};
      const onboard: Record<string, number> = {};
      for (const s of (info.symbols ?? []) as any[]) {
        if (s.quoteAsset === "USDT" && s.status === "TRADING") {
          const symUpper = String(s.symbol); // UPPER
          let tick = 0.01;
          const priceFilter = (s.filters || []).find((f: any) => f.filterType === "PRICE_FILTER");
          if (priceFilter?.tickSize) tick = Number(priceFilter.tickSize);
          else if (s.pricePrecision != null) tick = Math.pow(10, -Number(s.pricePrecision));
          digits[symUpper] = priceDigitsFromTick(tick);
          onboard[symUpper] = Number(s.onboardDate ?? 0);
          syms.push(symUpper.toLowerCase());
        }
      }
      const lim = settings.limitSymbols && settings.limitSymbols > 0 ? settings.limitSymbols : undefined;
      allSymbols.current = lim ? syms.slice(0, lim) : syms;
      priceDigits.current = digits;
      symbolOnboard.current = onboard;
      setReady(true);
    } catch (e) {
      console.error("exchangeInfo error", e);
    }
  }, [settings.limitSymbols]);

  const fetch24hTickers = useCallback(async () => {
    try {
      const res = await fetch(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`);
      const arr = (await res.json()) as any[];
      const map: Record<string, Ticker24h> = {};
      for (const t of arr) {
        const s = String(t.symbol || "");
        if (!s.endsWith("USDT")) continue; // USDT-M only
        map[s] = {
          quoteVolume: Number(t.quoteVolume || 0),
          priceChangePercent: Number(t.priceChangePercent || 0),
        };
      }
      ticker24h.current = map;
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchExchangeInfo();
  }, [fetchExchangeInfo]);

  useEffect(() => {
    fetch24hTickers();
    const id = setInterval(fetch24hTickers, 60_000);
    return () => clearInterval(id);
  }, [fetch24hTickers]);

  useEffect(() => {
    if (!ready || allSymbols.current.length === 0) return;
    const sockets: WebSocket[] = [];
    let closed = false;

    const openForTf = (tf: TF) => {
      const syms = allSymbols.current;
      const batches: string[][] = [];
      for (let i = 0; i < syms.length; i += MAX_STREAMS_PER_CONN) {
        batches.push(syms.slice(i, i + MAX_STREAMS_PER_CONN));
      }
      for (const batch of batches) {
        const streams = batch.map((s) => `${s}@kline_${tf}`).join("/");
        const url = `${WS_BASE}${streams}`;
        const ws = new WebSocket(url);
        ws.onmessage = (ev) => {
          try {
            const obj = JSON.parse(String(ev.data));
            const d = obj.data;
            if (!d) return;
            const sym: string = d.s; // UPPER
            const k = d.k || {};
            const o = Number(k.o), c = Number(k.c), h = Number(k.h ?? k.c), l = Number(k.l ?? k.c);
            const isClosed = Boolean(k.x);

            const nl = ensureTfMap(nowLive as any, tf);
            const oh = ensureTfMap(offHigh as any, tf);
            const lp = ensureTfMap(lastPrice as any, tf);
            const lh = ensureTfMap(lastHigh as any, tf);
            const ll = ensureTfMap(lastLow as any, tf);

            nl[sym] = ((c - o) / (o || 1)) * 100;
            oh[sym] = h !== 0 ? ((c - h) / h) * 100 : 0;
            lp[sym] = c; lh[sym] = h; ll[sym] = l;

            if (isClosed) {
              const hc = ensureTfMap(historyClosed as any, tf);
              const arr: number[] = hc[sym] ?? [];
              arr.push(((c - o) / (o || 1)) * 100);
              while (arr.length > 5) arr.shift();
              hc[sym] = arr;

              if (tf === MA_FILTER_TF && settings.useMAFilter) {
                const e = ensureEma(tf, sym, settings.maLen);
                e[settings.maLen] = emaNext(e[settings.maLen], c, settings.maLen);
              }
              if (tf === ALERT_SL_TF) {
                const e2 = ensureEma(tf, sym, settings.alertSLlen);
                e2[settings.alertSLlen] = emaNext(e2[settings.alertSLlen], c, settings.alertSLlen);
              }
            }
          } catch {
            // ignore
          }
        };
        ws.onclose = () => {
          if (!closed) setTimeout(() => openForTf(tf), 1500);
        };
        sockets.push(ws);
      }
    };

    TIMEFRAMES.forEach(openForTf);
    const uiTimer = setInterval(() => setTick((t) => t + 1), ROUND_ROBIN_DELAY);
    return () => {
      closed = true;
      sockets.forEach((s) => s.close());
      clearInterval(uiTimer);
    };
  }, [ready, settings.limitSymbols, settings.maLen, settings.alertSLlen, settings.useMAFilter]);

  // Alerts evaluator (in-app)
  useEffect(() => {
    if (!ready) return;
    const nowDt = Date.now();

    const getTopSetsByTf = (sourceTf: TF, topn: number) => {
      const nl = nowLive.current[sourceTf] || {};
      const syms = Object.keys(nl);
      if (syms.length === 0) return { gainers: new Set<string>(), losers: new Set<string>() };
      const sorted = syms.sort((a, b) => num(nl[a]) - num(nl[b]));
      const losers = new Set(sorted.slice(0, topn));
      const gainers = new Set(sorted.slice(-topn));
      return { gainers, losers };
    };

    const { gainers, losers } = getTopSetsByTf(USE_TOPN_SOURCE_TF, TOPN_SOURCE_LIMIT);

    for (const tf of ALERT_MIN_TFS) {
      const symsTf = Object.keys(nowLive.current[tf] || {});
      const cand = symsTf.filter((s) => gainers.has(s) || losers.has(s));

      for (const sym of cand) {
        const dq = historyClosed.current[tf]?.[sym] ?? [];
        const padded = [...Array(5 - dq.length).fill(null), ...dq];
        const nowv = getNum(nowLive.current[tf], sym);
        const offhv = getNum(offHigh.current[tf], sym);
        const price = getNum(lastPrice.current[tf], sym);
        const sig = baseForecastFromChanges([...padded, nowv]);
        if (!ALERT_SIGNALS.has(sig)) continue;

        const key = `ALERT|${sym}|${tf}|${sig}`;
        const st = (alertsRef.current[key] ?? {
          key,
          sym,
          tf,
          sig: sig as AlertState["sig"],
          firstSeen: nowDt,
          lastEdit: 0,
          entry: price,
          active: true,
          closed: false,
        }) as AlertState;

        const emaVal = emaCache.current[ALERT_SL_TF]?.[sym]?.[settings.alertSLlen];
        const isBuy = st.sig.includes("BUY");
        if (typeof emaVal === "number") {
          if (st.trailSL == null) st.trailSL = emaVal;
          else st.trailSL = isBuy ? Math.max(num(st.trailSL), emaVal) : Math.min(num(st.trailSL), emaVal);
        }

        let slHit = false;
        if (typeof st.trailSL === "number") {
          if (isBuy && price <= st.trailSL) slHit = true;
          if (!isBuy && price >= st.trailSL) slHit = true;
        }

        if (!slHit && nowDt - st.lastEdit < num(settings.alertEditIntervalSec) * 1000) {
          alertsRef.current[key] = st;
          continue;
        }

        if (slHit && !st.closed) {
          st.exitPrice = st.trailSL;
          st.plPct = isBuy
            ? ((num(st.exitPrice) - st.entry) / (st.entry || 1)) * 100
            : ((st.entry - num(st.exitPrice)) / (st.entry || 1)) * 100;
          st.closed = true;
          st.active = false;
        }
        st.lastEdit = nowDt;
        alertsRef.current[key] = st;
      }
    }

    // deactivate when signal gone
    for (const key of Object.keys(alertsRef.current)) {
      const st = alertsRef.current[key];
      if (!st.active || st.closed) continue;
      const currSig = baseForecastFromChanges([
        ...((historyClosed.current[st.tf]?.[st.sym] ?? []).slice(-5)),
        getNum(nowLive.current[st.tf], st.sym),
      ]);
      if (!ALERT_SIGNALS.has(currSig) || currSig !== st.sig) st.active = false;
    }
  }, [tick, ready, settings.alertEditIntervalSec, settings.alertSLlen]);

  const refreshExchangeInfo = useCallback(() => {
    setReady(false);
    fetchExchangeInfo();
  }, [fetchExchangeInfo]);

  return {
    ready,
    tick,
    nowLive,
    offHigh,
    lastPrice,
    lastHigh,
    lastLow,
    historyClosed,
    emaCache,
    priceDigits,
    symbolOnboard,
    allSymbols,
    ticker24h,
    settings,
    setSettings,
    alertsRef,
    refreshExchangeInfo,
  } as const;
}

/* =========================================
   SIGNAL HELPERS
========================================= */
function headerTwoRows(showSL: boolean) {
  const top = `${"Symbol".padEnd(SYMBOL_WIDTH)} ${"NOW%".padStart(NOW_WIDTH + 1)} ${"OffHigh%".padStart(OFFHIGH_WIDTH + 1)} ${"C-bars".padEnd(CSTRIP_CELLS)} ${"Forecast".padEnd(FORECAST_WIDTH)}`;
  const bottom = `${(showSL ? "Price | SL" : "Price").padEnd(SYMBOL_WIDTH)}`;
  return { top, bottom };
}

function makeSignal(base: string, tf: TF, sym: string, store: ReturnType<typeof useRealtimeStore>) {
  let signal = base;
  if (store.settings.useMAFilter) {
    const price = getNum(store.lastPrice.current[MA_FILTER_TF], sym);
    const emaVal = store.emaCache.current[MA_FILTER_TF]?.[sym]?.[store.settings.maLen];
    if (typeof price === "number" && typeof emaVal === "number") {
      if (["STRONG BUY","BUY","MOMENTUM BUY","REVERSAL BUY"].includes(signal) && price < emaVal)
        signal = "DONT BUY (Below MA)";
      else if (["STRONG SELL","SELL","MOMENTUM SELL","REVERSAL SELL"].includes(signal) && price > emaVal)
        signal = "DONT SELL (Above MA)";
    }
  }
  const nowv = getNum(store.nowLive.current[tf], sym);
  const offhv = getNum(store.offHigh.current[tf], sym);
  if (store.settings.useHighGuard && nowv > 0 && offhv >= store.settings.nearHighThresh) {
    signal = "TOO HIGH — DON'T BUY";
  } else {
    const dq = store.historyClosed.current[tf]?.[sym] ?? [];
    const c3 = num(dq[dq.length - 3]), c2 = num(dq[dq.length - 2]), c1 = num(dq[dq.length - 1]);
    const posSeq = [c3, c2, c1].filter((x) => x > 0).length;
    const price = getNum(store.lastPrice.current[MA_FILTER_TF], sym);
    const emaVal = store.emaCache.current[MA_FILTER_TF]?.[sym]?.[store.settings.maLen];
    if (posSeq >= store.settings.pumpMinSeq && nowv > 0 && typeof price === "number" && typeof emaVal === "number" && price > emaVal && offhv >= -1.0) {
      signal = "PUMP?";
    }
  }
  return signal;
}

function aggregateRecommendation(sym: string, store: ReturnType<typeof useRealtimeStore>) {
  const tfs: TF[] = ["5m","15m","1h","1d"];
  const weights: Record<string, number> = {
    "STRONG BUY": 2, "BUY": 1, "PUMP?": 1,
    "NEUTRAL": 0, "SIDEWAY": 0,
    "SELL": -1, "STRONG SELL": -2,
    "DONT BUY (Below MA)": 0, "DONT SELL (Above MA)": 0,
    "TOO HIGH — DON'T BUY": 0,
    "MOMENTUM BUY": 1, "MOMENTUM SELL": -1,
    "REVERSAL BUY": 1, "REVERSAL SELL": -1,
  };
  let score = 0;
  let strongBuy = 0, strongSell = 0, buy = 0, sell = 0, greenBoxes = 0, redBoxes = 0;

  for (const tf of tfs) {
    const dq = store.historyClosed.current[tf]?.[sym] ?? [];
    const padded = [...Array(5 - dq.length).fill(null), ...dq];
    const nl = store.nowLive.current[tf]?.[sym];
    const base = baseForecastFromChanges([...padded, num(nl)]);
    const sig = makeSignal(base, tf, sym, store);

    score += weights[sig] ?? 0;
    if (sig === "STRONG BUY") strongBuy++;
    if (sig === "STRONG SELL") strongSell++;
    if (sig.includes("BUY")) buy++;
    if (sig.includes("SELL")) sell++;
    for (const v of padded) {
      const n = num(v, 0);
      if (n > 0) greenBoxes++;
      else if (n < 0) redBoxes++;
    }
  }

  let label = "NEUTRAL";
  let color = "bg-muted text-foreground";
  if (strongBuy >= 2 || score >= 3) { label = "STRONG BUY"; color = "bg-emerald-600 text-white"; }
  else if (score > 0) { label = "BUY"; color = "bg-emerald-500/80 text-white"; }
  else if (strongSell >= 2 || score <= -3) { label = "STRONG SELL"; color = "bg-rose-600 text-white"; }
  else if (score < 0) { label = "SELL"; color = "bg-rose-500/80 text-white"; }

  return { label, color, metrics: { strongBuy, strongSell, buy, sell, greenBoxes, redBoxes, score } };
}

/* =========================================
   SCREENER (warna, tanpa legend & no scroll)
========================================= */
function tfTheme(tf: TF) {
  switch (tf) {
    case "1d":
      return { from: "from-emerald-500/70", to: "to-teal-500/70", ring: "ring-emerald-300/60" };
    case "1h":
      return { from: "from-sky-500/70", to: "to-cyan-500/70", ring: "ring-sky-300/60" };
    case "15m":
      return { from: "from-violet-500/70", to: "to-fuchsia-500/70", ring: "ring-violet-300/60" };
    case "5m":
      return { from: "from-amber-500/70", to: "to-orange-500/70", ring: "ring-amber-300/60" };
    case "1m":
      return { from: "from-rose-500/70", to: "to-pink-500/70", ring: "ring-rose-300/60" };
    default:
      return { from: "from-muted", to: "to-muted", ring: "ring-muted" };
  }
}

function ScreenerBlock({ store, tf, title }: { store: ReturnType<typeof useRealtimeStore>; tf: TF; title?: string }) {
  const { showSLinScreener, excludeLosersFromDisplay } = store.settings;
  const { top, bottom } = headerTwoRows(showSLinScreener);
  const theme = tfTheme(tf);

  const { rowsStr, updatedAt } = useMemo(() => {
    const symsAll = Object.keys(store.nowLive.current[tf] || {});
    if (symsAll.length === 0) {
      return { rowsStr: `${top}\n${bottom}\n\n(waiting for data…)`, updatedAt: new Date() };
    }
    const d1 = store.nowLive.current["1d"] || {};
    const sortedD1 = Object.keys(d1).sort((a, b) => num(d1[a]) - num(d1[b]));
    const topLosers = new Set(sortedD1.slice(0, TOPN_SOURCE_LIMIT));
    const topGainers = new Set(sortedD1.slice(-TOPN_SOURCE_LIMIT));

    let candidates = symsAll.filter((s) => topGainers.has(s));
    if (!candidates.length) candidates = symsAll;
    if (excludeLosersFromDisplay) candidates = candidates.filter((s) => !topLosers.has(s));

    const sorted = candidates
      .sort((a, b) => getNum(store.nowLive.current[tf], b) - getNum(store.nowLive.current[tf], a))
      .slice(0, store.settings.topN);

    const lines: string[] = [top, bottom, ""];
    for (const sym of sorted) {
      const dq = store.historyClosed.current[tf]?.[sym] ?? [];
      const padded = [...Array(5 - dq.length).fill(null), ...dq];
      const [c5, c4, c3, c2, c1] = padded as (number | null)[];
      const nowv = getNum(store.nowLive.current[tf], sym);
      const offhv = getNum(store.offHigh.current[tf], sym);
      const price = getNum(store.lastPrice.current[tf], sym);
      const digits = store.priceDigits.current[sym] ?? 4;

      const base = baseForecastFromChanges([c5 as any, c4 as any, c3 as any, c2 as any, c1 as any, nowv]);
      const signal = makeSignal(base, tf, sym, store);

      const symTxt = fitSym(sym, SYMBOL_WIDTH);
      const nowTxt = nowPctText(nowv).padStart(NOW_WIDTH + 1);
      const offTxt = offHighPctText(offhv).padStart(OFFHIGH_WIDTH + 1);
      const cstrip = padCstripToCells(cbarCompact(c5 as any, c4 as any, c3 as any, c2 as any, c1 as any), CSTRIP_CELLS);
      const signalTx = signal.padEnd(FORECAST_WIDTH);
      const priceTxt = fmtPrice(price, digits).padEnd(SYMBOL_WIDTH);

      const line1 = `${symTxt} ${nowTxt} ${offTxt} ${cstrip} ${signalTx}`.replace(/\s+$/g, "");
      const line2 = `${priceTxt}`;
      lines.push(line1, line2, "");
    }
    return { rowsStr: lines.join("\n"), updatedAt: new Date() };
  }, [store.tick, store.settings, tf]);

  return (
    <Card className={`overflow-hidden shadow-sm ring-1 ${theme.ring}`}>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <span className={`inline-flex h-5 rounded-full px-2 text-[10px] font-semibold text-white bg-gradient-to-r ${theme.from} ${theme.to}`}>
              {tf.toUpperCase()}
            </span>
            <span>{title ?? "Screener"}</span>
          </CardTitle>
          <div className={`h-1 w-28 rounded-full bg-gradient-to-r ${theme.from} ${theme.to}`} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border bg-gradient-to-br from-background to-muted/40">
          <pre className="font-mono text-xs p-4 leading-5 whitespace-pre-wrap">
{rowsStr}
          </pre>
        </div>
        <div className="text-xs text-muted-foreground mt-2">Updated: {updatedAt.toLocaleTimeString()}</div>
      </CardContent>
    </Card>
  );
}

function ScreenerGridView({ store }: { store: ReturnType<typeof useRealtimeStore> }) {
  return (
    <div className="space-y-6">
      {/* Baris 1: 1D kiri, 1H kanan */}
      <div className="grid lg:grid-cols-2 gap-6">
        <ScreenerBlock store={store} tf="1d" title="Screener — 1D" />
        <ScreenerBlock store={store} tf="1h" title="Screener — 1H" />
      </div>
      {/* Baris 2: 5M kiri, 15M kanan */}
      <div className="grid lg:grid-cols-2 gap-6">
        <ScreenerBlock store={store} tf="5m" title="Screener — 5M" />
        <ScreenerBlock store={store} tf="15m" title="Screener — 15M" />
      </div>
      {/* Baris 3: 1M full width */}
      <div>
        <ScreenerBlock store={store} tf="1m" title="Screener — 1M" />
      </div>
    </div>
  );
}

/* =========================================
   ALERTS
========================================= */
function AlertCard({ st, digits, d1 }: { st: AlertState; digits: number; d1?: number }) {
  const isBuy = st.sig.includes("BUY");
  return (
    <Card className={`border ${isBuy ? "border-emerald-500/40" : "border-rose-500/40"}`}>
      <CardHeader className="py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {isBuy ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            <span className="font-bold">{st.sig}</span>
            <Badge variant={isBuy ? "default" : "destructive"}>{st.tf.toUpperCase()}</Badge>
          </CardTitle>
          <div className="text-xs text-muted-foreground">{new Date(st.lastEdit).toLocaleTimeString()}</div>
        </div>
      </CardHeader>
      <CardContent className="text-sm space-y-1">
        <div className="font-semibold">{st.sym}</div>
        <div>Entry: <b>{fmtPrice(st.entry, digits)}</b></div>
        {typeof st.trailSL === "number" && <div>SL (trailing): <b>{fmtPrice(st.trailSL, digits)}</b></div>}
        {typeof d1 === "number" && <div>D1: {(d1 >= 0 ? "+" : "") + d1.toFixed(2)}%</div>}
        {st.closed && (
          <div className="text-xs mt-1">
            <span className="mr-2">✅ SL HIT</span>
            Exit: <b>{fmtPrice(st.exitPrice!, digits)}</b> | P/L: <b>{(num(st.plPct) >= 0 ? "+" : "") + num(st.plPct).toFixed(2)}%</b>
          </div>
        )}
        <div className="text-xs text-muted-foreground">Appeared: {new Date(st.firstSeen).toLocaleString()}</div>
      </CardContent>
    </Card>
  );
}

function AlertsView({ store }: { store: ReturnType<typeof useRealtimeStore> }) {
  const alertList = useMemo(
    () => Object.values(store.alertsRef.current).sort((a, b) => num(b.lastEdit) - num(a.lastEdit)),
    [store.tick]
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2"><ShieldAlert className="h-5 w-5" /> Live STRONG Alerts</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {alertList.length === 0 && <div className="text-sm text-muted-foreground">No strong alerts yet…</div>}
          {alertList.map((st) => (
            <AlertCard key={st.key} st={st} digits={store.priceDigits.current[st.sym] ?? 4} d1={store.nowLive.current["1d"]?.[st.sym]} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* =========================================
   SYMBOL EXPLORER (harga pojok kanan, chips, header TF, Forecast 2 kolom, + VOLATILITY sort)
========================================= */
function SymbolExplorer({ store }: { store: ReturnType<typeof useRealtimeStore> }) {
  // ===== state filter & sort =====
  type SymbolSortKey = "volatility" | "gainer" | "buySignals" | "greenBoxes" | "redBoxes";

  const [q, setQ] = useState("");
  const [newOnly, setNewOnly] = useState(false);
  const [days, setDays] = useState(14);
  const [sortKey, setSortKey] = useState<SymbolSortKey>("volatility");
  const [sortDesc, setSortDesc] = useState(true);

  // Filter GREEN boxes
  const [greenFilterOn, setGreenFilterOn] = useState(false);
  const [greenTf, setGreenTf] = useState<TF>("15m");
  const [minGreens, setMinGreens] = useState(3);

  const allUpper = useMemo(() => store.allSymbols.current.map((s) => s.toUpperCase()), [store.tick]);

  // Search + newOnly
  const filtered = useMemo(() => {
    const list = allUpper.filter((s) => s.includes(q.toUpperCase()));
    if (!newOnly) return list;
    const now = Date.now();
    const windowMs = days * 24 * 3600 * 1000;
    return list.filter((sym) => {
      const ob = store.symbolOnboard.current[sym] ?? 0;
      return ob > 0 && now - ob <= windowMs;
    });
  }, [allUpper, q, newOnly, days, store.tick]);

  // Filter GREEN by TF
  const filteredByGreen = useMemo(() => {
    if (!greenFilterOn) return filtered;
    return filtered.filter((sym) => {
      const dq = store.historyClosed.current[greenTf]?.[sym] ?? [];
      const padded = [...Array(5 - dq.length).fill(null), ...dq];
      let greens = 0;
      for (const v of padded) if (num(v, 0) > 0) greens++;
      return greens >= minGreens;
    });
  }, [filtered, greenFilterOn, greenTf, minGreens, store.tick]);

  // helper harga terbaru
  const latestPriceFor = (sym: string) => {
    const order: TF[] = ["1m", "5m", "15m", "1h", "1d"];
    for (const tf of order) {
      const v = store.lastPrice.current[tf]?.[sym];
      if (typeof v === "number") return v;
    }
    return undefined;
  };

  // skor volatilitas gabungan antar-TF (abs change 5 bar + Now%)
  const volatilityScore = (sym: string) => {
    const weights: Record<TF, number> = { "1m": 1.4, "5m": 1.3, "15m": 1.15, "1h": 1.0, "1d": 0.9 };
    let score = 0;
    for (const tf of ["1m","5m","15m","1h","1d"] as TF[]) {
      const bars = store.historyClosed.current[tf]?.[sym] ?? [];
      const absAvg = bars.length
        ? bars.reduce((a, b) => a + Math.abs(num(b)), 0) / bars.length
        : 0;
      const nowAbs = Math.abs(num(store.nowLive.current[tf]?.[sym], 0));
      // campuran 70% historis, 30% live; lalu dibobot per TF
      const tfScore = (absAvg * 0.7 + nowAbs * 0.3) * (weights[tf] ?? 1);
      score += tfScore;
    }
    return score;
  };

  // Build data per symbol (tanpa volume)
  const enriched = useMemo(() => {
    return filteredByGreen.map((sym) => {
      const t24 = store.ticker24h.current[sym];
      const change24h = Number.isFinite(t24?.priceChangePercent)
        ? t24!.priceChangePercent
        : (store.nowLive.current["1d"]?.[sym] ?? 0);
      const chg1h = store.nowLive.current["1h"]?.[sym] ?? 0;
      const chg15m = store.nowLive.current["15m"]?.[sym] ?? 0;

      const agg = aggregateRecommendation(sym, store);
      const buySignals = agg.metrics.buy;
      const greenBoxes = agg.metrics.greenBoxes;
      const redBoxes = agg.metrics.redBoxes;

      const volScore = volatilityScore(sym);

      return { sym, change24h, chg1h, chg15m, buySignals, greenBoxes, redBoxes, volScore, agg };
    });
  }, [filteredByGreen, store.tick]);

  const keyToProp: Record<SymbolSortKey, keyof (typeof enriched)[number]> = {
    volatility: "volScore",
    gainer: "change24h",
    buySignals: "buySignals",
    greenBoxes: "greenBoxes",
    redBoxes: "redBoxes",
  };

  const sorted = useMemo(() => {
    const arr = [...enriched];
    const prop = keyToProp[sortKey];
    arr.sort((A, B) => {
      const a = A[prop] as number, b = B[prop] as number;
      if (a === b) return A.sym.localeCompare(B.sym);
      return sortDesc ? b - a : a - b;
    });
    return arr;
  }, [enriched, sortKey, sortDesc]);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4">
        {/* search + new only */}
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <CardTitle className="text-xl flex items-center gap-2">
              <Search className="h-5 w-5" /> Symbol Explorer
            </CardTitle>
            <Input
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder="Search symbol… e.g., BTCUSDT"
              className="w-64"
            />
          </div>

          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <Label className="cursor-pointer">New only</Label>
              <Switch checked={newOnly} onCheckedChange={setNewOnly} />
            </div>
            {newOnly ? (
              <div className="flex items-center gap-2">
                <Label>≤ {days}d</Label>
                <Slider className="w-40" value={[days]} min={1} max={30} step={1} onValueChange={(v) => setDays(v[0])} />
              </div>
            ) : null}
          </div>
        </div>

        {/* Green Filter + Sort */}
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-4 text-xs">
            <div className="flex items-center gap-2">
              <Label className="cursor-pointer">Filter GREEN boxes</Label>
              <Switch checked={greenFilterOn} onCheckedChange={setGreenFilterOn} />
            </div>
            <div className="flex items-center gap-2">
              <Label>TF</Label>
              <select
                className="px-2 py-1 border rounded-md bg-background"
                value={greenTf}
                onChange={(e) => setGreenTf(e.target.value as TF)}
                disabled={!greenFilterOn}
              >
                <option value="1m">1m</option>
                <option value="5m">5m</option>
                <option value="15m">15m</option>
                <option value="1h">1h</option>
                <option value="1d">1d</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <Label>Min 🟩</Label>
              <Slider
                className="w-40"
                value={[minGreens]}
                min={1}
                max={5}
                step={1}
                onValueChange={(v) => setMinGreens(v[0])}
                disabled={!greenFilterOn}
              />
              <span className="text-muted-foreground">{minGreens}</span>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            Sort by:&nbsp;
            <select
              className="px-2 py-1 border rounded-md bg-background"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SymbolSortKey)}
            >
              <option value="volatility">Most Volatile (multi-TF)</option>
              <option value="gainer">Top Gainer (24h %)</option>
              <option value="buySignals">Most BUY signals</option>
              <option value="greenBoxes">Most GREEN boxes</option>
              <option value="redBoxes">Most RED boxes</option>
            </select>
            <Button variant="secondary" size="sm" className="ml-2" onClick={() => setSortDesc((v) => !v)}>
              {sortDesc ? "▼ Desc" : "▲ Asc"}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        {/* grid 2 kolom */}
        <ScrollArea className="h-[520px] rounded-md border p-3">
          <div className="grid md:grid-cols-2 gap-4">
            {sorted.length === 0 && <div className="text-sm text-muted-foreground">No symbols match.</div>}

            {sorted.map(({ sym, change24h, chg1h, chg15m, buySignals, greenBoxes, redBoxes, agg }) => {
              const priceNow = latestPriceFor(sym);
              const digits = store.priceDigits.current[sym] ?? 4;

              const tiles = TIMEFRAMES.map((tf) => {
                const nl = store.nowLive.current[tf]?.[sym];
                const oh = store.offHigh.current[tf]?.[sym];
                const dq = store.historyClosed.current[tf]?.[sym] ?? [];
                const padded = [...Array(5 - dq.length).fill(null), ...dq];
                const base = baseForecastFromChanges([...padded, num(nl)]);
                const sig = makeSignal(base, tf, sym, store);
                return {
                  tf,
                  nl,
                  oh,
                  sig,
                  cstrip: cbarCompact(
                    padded[0] as any, padded[1] as any, padded[2] as any, padded[3] as any, padded[4] as any
                  ),
                };
              });

              return (
                <div key={sym} className="rounded-2xl border p-3 shadow-sm bg-card/50">
                  {/* header: symbol + rekomendasi + harga */}
                  <div className="flex items-start justify-between mb-2">
                    <div className="font-semibold flex items-center gap-2">
                      {sym}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${agg.color}`}>{agg.label}</span>
                      <Badge variant="secondary">USDT-M</Badge>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-base font-semibold leading-none">
                        {priceNow != null ? fmtPrice(priceNow, digits) : "-"}
                      </div>
                    </div>
                  </div>

                  {/* chips perubahan (rapi), lalu ENTER sebelum header kolom */}
                  <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
                    <span className="px-2 py-0.5 rounded-full bg-muted">
                      <b>Chg 24h</b>: <span className={posNegClass(change24h)}>{fmtPct(change24h)}</span>
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-muted">
                      <b>Chg 1h</b>: <span className={posNegClass(chg1h)}>{fmtPct(chg1h)}</span>
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-muted">
                      <b>Chg 15m</b>: <span className={posNegClass(chg15m)}>{fmtPct(chg15m)}</span>
                    </span>

                    <span className="hidden md:inline px-2 py-0.5 rounded-full bg-muted/60">
                      <b>BUY sig</b>: {buySignals}
                    </span>
                    <span className="hidden md:inline px-2 py-0.5 rounded-full bg-muted/60">🟩: {greenBoxes}</span>
                    <span className="hidden md:inline px-2 py-0.5 rounded-full bg-muted/60">🟥: {redBoxes}</span>
                  </div>

                  {/* ENTER (spasi vertikal) */}
                  <div className="h-1" />

                  {/* header kolom TF: bar background + rounded */}
                  <div className="grid grid-cols-6 text-[11px] font-medium bg-muted/50 rounded-md px-2 py-1 mb-1">
                    <div>TF</div>
                    <div className="text-right">Now%</div>
                    <div className="text-right">OffHigh%</div>
                    <div>C-bars</div>
                    <div className="col-span-2">Forecast</div>
                  </div>

                  {/* rows TF: forecast 2 kolom, warna persentase & forecast */}
                  <div className="space-y-1.5">
                    {tiles.map((t) => (
                      <div
                        key={t.tf}
                        className="grid grid-cols-6 items-center text-xs gap-2 rounded-md px-2 py-1 hover:bg-accent/40 transition-colors"
                      >
                        <div className="col-span-1 font-mono">{t.tf.toUpperCase()}</div>
                        <div className={`col-span-1 font-mono text-right ${posNegClass(num(t.nl))}`}>
                          {t.nl != null ? nowPctText(t.nl) : "n/a"}
                        </div>
                        <div className={`col-span-1 font-mono text-right ${posNegClass(num(t.oh) * -1)}`}>
                          {t.oh != null ? offHighPctText(t.oh) : "n/a"}
                        </div>
                        <div className="col-span-1 font-mono">{padCstripToCells(t.cstrip, CSTRIP_CELLS)}</div>
                        <div className={`col-span-2 truncate ${forecastTone(t.sig)}`} title={t.sig}>
                          {t.sig}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

/* =========================================
   SETTINGS
========================================= */
function SettingsView({ store }: { store: ReturnType<typeof useRealtimeStore> }) {
  const handleLimitChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.currentTarget.value);
    const safe = Math.max(0, Number.isFinite(raw) ? Math.floor(raw) : 0);
    store.setSettings((s) => ({ ...s, limitSymbols: safe }));
  };
  const handleEditIntervalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.currentTarget.value);
    const safe = Math.max(2, Number.isFinite(raw) ? raw : 4);
    store.setSettings((s) => ({ ...s, alertEditIntervalSec: safe }));
  };
  const handleSLlenChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.currentTarget.value);
    const safe = Math.max(3, Number.isFinite(raw) ? Math.floor(raw) : 15);
    store.setSettings((s) => ({ ...s, alertSLlen: safe }));
  };
  const handleTopNChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = Number(e.currentTarget.value);
    const safe = Math.min(50, Math.max(5, Number.isFinite(raw) ? Math.floor(raw) : TOP_N_DEFAULT));
    store.setSettings((s) => ({ ...s, topN: safe }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2"><Settings className="h-5 w-5" /> System Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid md:grid-cols-2 gap-6">
          <div className="space-y-3 rounded-xl border p-4">
            <div className="font-semibold mb-1">Data & Performance</div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Limit symbols (0 = ALL)</Label>
              <Input className="w-28" type="number" value={store.settings.limitSymbols ?? 0} onChange={handleLimitChange} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Refresh exchangeInfo (reload symbols)</Label>
              <Button size="sm" onClick={() => store.refreshExchangeInfo()}>Refresh</Button>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Top N rows (screener)</Label>
              <Input className="w-28" type="number" value={store.settings.topN} onChange={handleTopNChange} />
            </div>
            <div className="text-xs text-muted-foreground">Set limit ke 0 agar semua pair (termasuk koin baru) diambil. Klik <b>Refresh</b> jika listing baru muncul saat app sudah berjalan.</div>
          </div>

          <div className="space-y-3 rounded-xl border p-4">
            <div className="font-semibold mb-1">Signals</div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Alert edit interval (sec)</Label>
              <Input className="w-28" type="number" value={store.settings.alertEditIntervalSec} onChange={handleEditIntervalChange} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Trailing SL EMA length (1m)</Label>
              <Input className="w-28" type="number" value={store.settings.alertSLlen} onChange={handleSLlenChange} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Use MA guard (5m EMA)</Label>
              <Switch checked={store.settings.useMAFilter} onCheckedChange={(v) => store.setSettings((s) => ({ ...s, useMAFilter: v }))} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">Near-High Guard</Label>
              <Switch checked={store.settings.useHighGuard} onCheckedChange={(v) => store.setSettings((s) => ({ ...s, useHighGuard: v }))} />
            </div>
          </div>
        </div>

        <Separator />
        <div className="text-xs text-muted-foreground">
          <p><b>Notes:</b> WebSocket Binance Futures. Jika berat, kurangi limit symbol atau Top N.</p>
          <p className="mt-2">Filter <i>New only</i> pakai <code>onboardDate</code>. Gunakan <b>Refresh</b> untuk muat pair baru.</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* =========================================
   APP
========================================= */
export default function RealtimeFuturesScreenerApp() {
  const store = useRealtimeStore();

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <header className="sticky top-0 z-10 backdrop-blur border-b bg-background/70">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 120 }}
              className="h-9 w-9 rounded-2xl shadow-inner bg-primary/10 grid place-items-center"
            >
              <span className="text-lg">⚡</span>
            </motion.div>
            <div>
              <div className="text-lg font-bold tracking-tight">Realtime Futures Screener</div>
              <div className="text-xs text-muted-foreground -mt-0.5">USDT-M | Multi-TF | Strong Alerts</div>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">{new Date().toLocaleString()}</div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {!store.ready ? (
          <Card>
            <CardContent className="py-16 text-center text-sm text-muted-foreground">Connecting to Binance, fetching symbols…</CardContent>
          </Card>
        ) : (
          <Tabs defaultValue="screener" className="space-y-6">
            <TabsList className="grid grid-cols-4 w-full md:w-[640px]">
              <TabsTrigger value="screener">Screener</TabsTrigger>
              <TabsTrigger value="alerts">Alerts</TabsTrigger>
              <TabsTrigger value="symbol">Symbol</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>

            <TabsContent value="screener" className="space-y-4">
              <ScreenerGridView store={store} />
            </TabsContent>

            <TabsContent value="alerts" className="space-y-4">
              <AlertsView store={store} />
            </TabsContent>

            <TabsContent value="symbol" className="space-y-4">
              <SymbolExplorer store={store} />
            </TabsContent>

            <TabsContent value="settings" className="space-y-4">
              <SettingsView store={store} />
            </TabsContent>
          </Tabs>
        )}
      </main>

      <footer className="py-8 text-center text-xs text-muted-foreground">
        Built with ❤ — mirrors your Python bot logic (EMA trailing SL, strong signals, multi-TF screener). No Telegram here; purely web.
      </footer>
    </div>
  );
}
