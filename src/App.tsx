import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import "./App.css";
import type { CatalogApi, Session, AlarmItem } from "./types";
import { fetchCatalog, createApi, updateApi, deleteApi, getApiId } from "./services/manager";
import { loginAndGetToken, collectAlarmsBatch } from "./services/collector";

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function printGroupReport(
  g: GroupRow,
  comments: { created_at: string; text: string; status?: string | null }[],
  occurrenceOf: (it: AlarmItem) => number
) {
  // monta linhas unificadas (ocorrências + comentários) em ordem cronológica
  type R = { ts: number; tipo: "Alarme" | "Comentário"; status?: string; texto: string; extra?: string };
  const rows: R[] = [];

  // ocorrências
  for (const it of g.items) {
    const L: any = it;
    const ts = occurrenceOf(it);
    const valor = `${L.triggerValue_value ?? L.triggerValue?.value ?? ""} ${L.triggerValue_units ?? L.triggerValue?.units ?? ""}`.trim();
    const extra = [
      L.type ? `Tipo: ${L.type}` : "",
      Number.isFinite(L.priority) ? `Prioridade: ${L.priority}` : "",
      valor ? `Valor: ${valor}` : "",
      L.isAcknowledged ? "Reconhecido" : "",
      L.isDiscarded ? "Descartado" : "",
    ].filter(Boolean).join(" · ");

    rows.push({
      ts,
      tipo: "Alarme",
      status: String(L.type ?? ""),
      texto: String(L.message ?? ""),
      extra,
    });
  }

  // comentários
  for (const c of comments) {
    const ts = safeToMs(c.created_at);
    rows.push({
      ts,
      tipo: "Comentário",
      status: c.status ?? "",
      texto: c.text ?? "",
    });
  }

  rows.sort((a, b) => a.ts - b.ts);

  // estilos do relatório (auto contido)
  const styles = `
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Noto Sans", sans-serif; color:#0f172a; margin:0; }
    .wrap { padding: 28px; }
    .hdr {
      display:flex; align-items:flex-start; justify-content:space-between; gap:16px;
      border-bottom: 2px solid #e5e7eb; padding-bottom: 14px; margin-bottom: 18px;
    }
    .title { margin:0; font-size: 22px; font-weight: 800; letter-spacing:.2px; color:#0f172a; }
    .muted { color:#475569; }
    .meta {
      display:grid; gap:6px; grid-template-columns: 1fr 1fr;
      background:#f8fafc; border:1px solid #e5e7eb; border-radius:12px; padding:12px 14px; margin: 14px 0 20px;
    }
    .meta div { font-size: 13px; }
    .pill { display:inline-block; padding:2px 8px; border:1px solid #e5e7eb; border-radius:999px; font-size:12px; background:#fff; }
    .sec-title { font-size:14px; font-weight:700; margin:12px 0 8px; color:#0f172a; text-transform: uppercase; letter-spacing:.04em; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
    thead th {
      text-align:left; background:#f8fafc; border:1px solid #e5e7eb; border-bottom:none;
      padding:8px 10px; font-weight:700;
    }
    tbody td {
      border:1px solid #f1f5f9; border-top:none; padding:8px 10px; vertical-align:top;
    }
    tbody tr:nth-child(even) td { background:#fbfdff; }
    .ts { white-space: nowrap; }
    .small { font-size:12px; color:#475569; }
    .grid2 { display:grid; gap:6px; grid-template-columns: 1fr 1fr; }
    .right { text-align:right; }
    @media print {
      .wrap { padding: 12mm; }
      .meta { page-break-inside: avoid; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
    }
  `;

  const occurrences = g.items
    .slice()
    .sort((a, b) => occurrenceOf(a) - occurrenceOf(b))
    .map((it) => {
      const L: any = it;
      const ts = occurrenceOf(it);
      const valor = `${L.triggerValue_value ?? L.triggerValue?.value ?? ""} ${L.triggerValue_units ?? L.triggerValue?.units ?? ""}`.trim();
      return `
        <tr>
          <td class="ts">${esc(msToDMYTime(ts))}</td>
          <td>${esc(L.type ?? "—")}</td>
          <td class="right">${esc(Number.isFinite(L.priority) ? L.priority : "—")}</td>
          <td>${esc(valor)}</td>
          <td>${esc(L.message ?? "")}</td>
        </tr>
      `;
    })
    .join("");

  const commentsRows = comments
    .slice()
    .sort((a, b) => safeToMs(a.created_at) - safeToMs(b.created_at))
    .map((c) => `
      <tr>
        <td class="ts">${esc(msToDMYTime(safeToMs(c.created_at)))}</td>
        <td>${esc(c.status ?? "—")}</td>
        <td>${esc(c.text ?? "")}</td>
      </tr>
    `)
    .join("");

  const html = `
    <!doctype html>
    <html lang="pt-br">
    <head>
      <meta charset="utf-8">
      <title>Relatório de alarmes - ${esc(g.name || g.itemReference || "item")}</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${styles}</style>
    </head>
    <body>
      <div class="wrap">
        <div class="hdr">
          <div>
            <h1 class="title">Relatório de alarmes</h1>
            <div class="muted">Gerado em ${esc(msToDMYTime(Date.now()))}</div>
          </div>
          <div class="muted small">MANEGE ALARM VIEWER</div>
        </div>

        <div class="meta">
          <div><strong>Servidor:</strong> ${esc(g.servidorName || "—")}</div>
          <div><strong>Última ocorrência:</strong> ${esc(msToDMYTime(g.latestInsertedMs))}</div>
          <div><strong>Nome:</strong> ${esc(g.name || "—")}</div>
          <div><strong>Referência:</strong> ${esc(g.itemReference || "—")}</div>
          <div><strong>Mensagem (mais recente):</strong> ${esc(g.message || "—")}</div>
          <div><strong>Status atual:</strong> <span class="pill">${esc((g as any)._statusShown || "—")}</span></div>
        </div>

        <div class="sec-title">Ocorrências</div>
        <table>
          <thead>
            <tr>
              <th>Data/Hora</th>
              <th>Tipo</th>
              <th>Prior.</th>
              <th>Valor</th>
              <th>Mensagem</th>
            </tr>
          </thead>
          <tbody>
            ${occurrences || `<tr><td colspan="5" class="small">Sem ocorrências.</td></tr>`}
          </tbody>
        </table>

        <div class="sec-title" style="margin-top:18px;">Comentários</div>
        <table>
          <thead>
            <tr>
              <th>Data/Hora</th>
              <th>Status</th>
              <th>Texto</th>
            </tr>
          </thead>
          <tbody>
            ${commentsRows || `<tr><td colspan="3" class="small">Sem comentários.</td></tr>`}
          </tbody>
        </table>
      </div>

      <script>
        // aguarda pintura e chama impressão
        setTimeout(() => { window.print(); }, 300);
      </script>
    </body>
    </html>
  `;

  const w = window.open("", "_blank", "width=1100,height=800");
  if (!w) { alert("Bloqueado pelo navegador. Permita pop-ups para imprimir."); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}


function exportGroupToCSV(g: GroupRow, comments: any[], occurrenceOf: (it: AlarmItem) => number) {
  // Colunas pensadas para importar bem no Excel PT-BR (usando ";")
  const headerCols = [
    "Data", "Origem", "Servidor", "Nome", "Referência", "Tipo", "Prioridade",
    "Valor", "Unidade", "Status", "Texto"
  ];

  const q = (v: unknown) => {
    // aspas duplas dobradas + preserva ; e quebras de linha
    const s = String(v ?? "");
    return `"${s.replace(/"/g, '""')}"`;
  };

  type Row = { data: number; cols: string[] };
  const rows: Row[] = [];

  // 1) Alarmes do card
  for (const it of g.items) {
    const L: any = it;
    const dataMs = occurrenceOf(it);
    rows.push({
      data: dataMs,
      cols: [
        msToDMYTime(dataMs),
        "Alarme",
        g.servidorName || "",
        g.name || "",
        g.itemReference || "",
        L.type ?? "",
        String(L.priority ?? ""),
        String(L.triggerValue_value ?? L.triggerValue?.value ?? ""),
        String(L.triggerValue_units ?? L.triggerValue?.units ?? ""),
        "",                              // status (não se aplica ao "evento alarme")
        L.message ?? "",
      ].map(q),
    });
  }

  // 2) Comentários do card
  for (const c of comments) {
    const dataMs = safeToMs(c.created_at);
    rows.push({
      data: dataMs,
      cols: [
        msToDMYTime(dataMs),
        "Comentário",
        g.servidorName || "",
        g.name || "",
        g.itemReference || "",
        "", "", "", "",                  // tipo/prioridade/valor/unidade (n/a)
        c.status ?? "",
        c.text ?? "",
      ].map(q),
    });
  }

  // 3) Ordena cronologicamente (crescente)
  rows.sort((a, b) => a.data - b.data);

  const header = headerCols.join(";");           // separador ;
  const body = rows.map(r => r.cols.join(";")).join("\r\n"); // linhas CRLF
  const csv = header + "\r\n" + body;

  // BOM para Excel PT-BR reconhecer UTF-8
  const bom = "\uFEFF";
  const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8;" });

  // nome de arquivo seguro
  const fname = `${(g.name || g.itemReference || "alarmes")
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 80)}.csv`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fname;
  a.click();
  URL.revokeObjectURL(url);
}



function pLimit(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => { active--; queue.shift()?.(); };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>(r => queue.push(r));
    active++;
    try { return await fn(); } finally { next(); }
  };
}

const tokenCache = new Map<string, { token: string; exp: number }>();
const TOKEN_TTL_MS = 15 * 60_000;
async function getTokenCached(baseUrl: string, usuario?: string, senha?: string): Promise<string> {
  const k = `${baseUrl}::${usuario ?? ""}`;
  const hit = tokenCache.get(k);
  const now = Date.now();
  if (hit && hit.exp > now) return hit.token;
  const t = await loginAndGetToken({ base_url: baseUrl, usuario: usuario!, senha: senha!, verify_ssl: false });
  tokenCache.set(k, { token: t, exp: now + TOKEN_TTL_MS });
  return t;
}

type CatalogApiLoose = CatalogApi & {
  IP?: string;
  Versao?: string;
  Link?: string;
  BaseUrl: string;
  Servidor?: string;
  Usuario?: string;
  Senha?: string;
  QuantidadeAlarmes?: number;
  offset?: number;
};

/* =========================
   Helpers / Types
   ========================= */
const clip = (s: unknown, max = 60) => {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const toUiLink = (u?: string) => (u ?? "").replace(/\/api\/V?\d+$/i, "/UI/alarms/");

type SortKey =
  | "servidor"
  | "name"
  | "itemReference"
  | "message"
  | "value"
  | "priority"
  | "type"
  | "isAcknowledged"
  | "isDiscarded"
  | "inserido"
  | "tratativa";

type GroupRow = {
  key: string;
  name: string;
  itemReference: string;
  message?: string;
  value?: string | number | null;
  units?: string | null;
  priority?: number | null;
  type?: string | null;
  isAcknowledged: boolean;
  isDiscarded: boolean;
  latestInsertedMs: number;
  servidorName: string;
  servidorHref: string | null;
  base: string;
  items: AlarmItem[];
  _latest: AlarmItem | null;
};

const safeToMs = (s?: string) => {
  if (!s) return 0;
  const t = s.trim();


  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? ms : 0;
  }

 
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(t)) {
    const [datePart, timePart] = t.split(/\s+/);
    const [Y, M, D] = datePart.split("-").map((n) => Number(n));
    const [h, m, s2] = (timePart || "00:00:00").split(":").map((n) => Number(n));
    const dt = new Date(Y, (M || 1) - 1, D || 1, h || 0, m || 0, s2 || 0);
    return dt.getTime();
  }


  if (/^\d{2}\/\d{2}\/\d{4}/.test(t)) {
    const [datePart, timePart] = t.split(/\s+/);
    const [a, b, Y] = datePart.split("/").map((n) => Number(n));
    const [h, m, s2] = (timePart || "00:00:00").split(":").map((n) => Number(n));

    const D = a || 1;
    const M = b || 1;
    const dt = new Date(Y || 1970, (M || 1) - 1, D || 1, h || 0, m || 0, s2 || 0);
    return dt.getTime();
  }

  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
};

const msToDMYTime = (ms?: number) => {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};


const isoToMs = (s?: string) => safeToMs(s);
const addHours = (ms: number, h: number) => ms + h * 3_600_000;
const num = (x: unknown) => {
  const s = String(x ?? "").replace(",", ".").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const dateInputToMs = (s: string, end = false) => {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = end ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
  return dt.getTime();
};
const mask = (s?: string) => "•".repeat(Math.max(4, Math.min(12, (s?.length ?? 0) || 6)));
const fmtMMSS = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const summarize = (sel: string[], total: number) => (sel.length === 0 || sel.length === total ? "(Todos)" : `${sel.length} selecionado(s)`);
const lanes = ["Não tratado", "Em andamento", "Concluído", "Oportunidade"] as const;
type Lane = (typeof lanes)[number];

const isNormalized = (g: GroupRow) => {
  const L = (g._latest as any) ?? {};
  const type = String(L?.type ?? g.type ?? "").toLowerCase();
  const val = String(L?.triggerValue_value ?? L?.triggerValue?.value ?? g.value ?? "").toLowerCase();
  return val === "online" || type === "normal" || type === "online";
};

export default function App() {
  /* =========================
     State
     ========================= */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<AlarmItem[]>([]);

const inflightAbort = useRef<AbortController | null>(null);
const bufferRef = useRef<AlarmItem[]>([]);
  const [catalogLocal, setCatalogLocal] = useState<CatalogApiLoose[]>([]);
  const [serverNameByBase, setServerNameByBase] = useState<Record<string, string>>({});
  const [offsetByBase, setOffsetByBase] = useState<Record<string, number>>({});

  const [sortKey, setSortKey] = useState<SortKey>("inserido");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [fServidores, setFServidores] = useState<string[]>([]);
  const [fTipos, setFTipos] = useState<string[]>([]);
  const [fTratativas, setFTratativas] = useState<string[]>([]);
  const [fNome, setFNome] = useState("");
  const [fItemRef, setFItemRef] = useState("");
  const [fMensagem, setFMensagem] = useState("");
  const [fValorTxt, setFValorTxt] = useState("");
  const [fPriorMin, setFPriorMin] = useState("");
  const [fPriorMax, setFPriorMax] = useState("");
  const [fAck, setFAck] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fInsDe, setFInsDe] = useState("");
  const [fInsAte, setFInsAte] = useState("");

  const [modalGroup, setModalGroup] = useState<GroupRow | null>(null);
  const [apisOpen, setApisOpen] = useState(false);
  const [apisError, setApisError] = useState<string | null>(null);
  const [apisBusy, setApisBusy] = useState(false);
  const [apisNotice, setApisNotice] = useState<string | null>(null);
  const [testBusyById, setTestBusyById] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<"table" | "kanban">("table");

  type ErrorEntry = { id: string; title: string; details: string; port?: string | number };
  const [apiErrors, setApiErrors] = useState<ErrorEntry[]>([]);
  const [errorModal, setErrorModal] = useState<{ open: boolean; entry: ErrorEntry | null }>({ open: false, entry: null });

  type ApiForm = { Servidor: string; IP: string; Usuario: string; offset: number; Versao: string; QuantidadeAlarmes: number; Senha: string };
  const emptyForm: ApiForm = { Servidor: "", IP: "", Usuario: "", offset: 0, Versao: "V3", QuantidadeAlarmes: 1, Senha: "" };
  const [form, setForm] = useState<ApiForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  const REFRESH_MS = 60_000;
  const [nextTs, setNextTs] = useState<number>(() => Date.now() + REFRESH_MS);
  const [leftSec, setLeftSec] = useState<number>(Math.ceil((nextTs - Date.now()) / 1000));

  /* =========================
     Derived
     ========================= */
  const occurrenceMsWithOffset = useCallback(
    (it: AlarmItem) => {
      const base = (it as any).source_base_url ?? (it as any).__source_base_url ?? "";
      const off = offsetByBase[base] ?? 0;
      const ms = isoToMs((it as any).creationTime);
      return ms ? addHours(ms, off) : 0;
    },
    [offsetByBase]
  );
  const insertedMs = occurrenceMsWithOffset;

  const uniqTipos = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) if (it.type) s.add(String(it.type));
    return [...s].sort();
  }, [items]);

  const uniqServidores = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) {
      const base = (it as any).source_base_url ?? (it as any).__source_base_url ?? "";
      const name = serverNameByBase[base] ?? base.replace(/^https?:\/\//, "");
      if (name) s.add(name);
    }
    return [...s].sort();
  }, [items, serverNameByBase]);

  const filteredItems = useMemo(() => {
    const nome = fNome.toLowerCase().trim();
    const ref = fItemRef.toLowerCase().trim();
    const msg = fMensagem.toLowerCase().trim();
    const valorTxt = fValorTxt.toLowerCase().trim();
    const pMin = fPriorMin ? num(fPriorMin) : null;
    const pMax = fPriorMax ? num(fPriorMax) : null;
    const tMinIns = dateInputToMs(fInsDe, false);
    const tMaxIns = dateInputToMs(fInsAte, true);

    return items.filter((it) => {
      const base = (it as any).source_base_url ?? (it as any).__source_base_url ?? "";
      const servidor = serverNameByBase[base] ?? base.replace(/^https?:\/\//, "");
      if (fServidores.length && !fServidores.includes(servidor)) return false;
      if (nome && !String(it.name ?? "").toLowerCase().includes(nome)) return false;
      if (ref && !String(it.itemReference ?? "").toLowerCase().includes(ref)) return false;
      if (msg && !String(it.message ?? "").toLowerCase().includes(msg)) return false;
      const v = (it as any).triggerValue_value ?? (it as any).triggerValue?.value ?? "";
      const u = (it as any).triggerValue_units ?? (it as any).triggerValue?.units ?? "";
      if (valorTxt && !(`${v} ${u}`.trim().toLowerCase().includes(valorTxt))) return false;
      const pr = num(it.priority);
      if (pMin != null && (pr == null || pr < pMin)) return false;
      if (pMax != null && (pr == null || pr > pMax)) return false;
      const tipoItem = String(it.type ?? "");
      if (fTipos.length && !fTipos.includes(tipoItem)) return false;
      if (fAck === "sim" && !it.isAcknowledged) return false;
      if (fAck === "nao" && it.isAcknowledged) return false;
      if (fDesc === "sim" && !it.isDiscarded) return false;
      if (fDesc === "nao" && it.isDiscarded) return false;

      const ins = insertedMs(it);
      if (tMinIns != null && (ins === 0 || ins < tMinIns)) return false;
      if (tMaxIns != null && (ins === 0 || ins > tMaxIns)) return false;

      return true;
    });
  }, [
    items,
    fServidores,
    fTipos,
    fNome,
    fItemRef,
    fMensagem,
    fValorTxt,
    fPriorMin,
    fPriorMax,
    fAck,
    fDesc,
    fInsDe,
    fInsAte,
    serverNameByBase,
    insertedMs,
  ]);

  const groupedRowsRaw = useMemo<GroupRow[]>(() => {
    const map = new Map<string, AlarmItem[]>();
    for (const it of filteredItems) {
      const key = `${it.name ?? ""}||${it.itemReference ?? ""}`;
      (map.get(key) ?? (map.set(key, []), map.get(key)!)).push(it);
    }
    const rows: GroupRow[] = [];
    for (const [key, arr] of map) {
      let latest: AlarmItem | null = null;
      let latestOcc = -1;
      let highest: AlarmItem | null = null;
      let highestPr = -Infinity;
      for (const it of arr) {
        const occ = insertedMs(it);
        if (occ > latestOcc) {
          latestOcc = occ;
          latest = it;
        }
        const p = num(it.priority) ?? -Infinity;
        if (p > highestPr) {
          highestPr = p;
          highest = it;
        }
      }
      const L = latest ?? arr[0];
      const H = highest ?? L;
      const base = (L as any).source_base_url ?? (L as any).__source_base_url ?? "";
      const servidorName = serverNameByBase[base] ?? base.replace(/^https?:\/\//, "");
      const servidorHref = base ? toUiLink(base) : null;
      const value = (L as any).triggerValue_value ?? (L as any).triggerValue?.value ?? null;
      const units = (L as any).triggerValue_units ?? (L as any).triggerValue?.units ?? null;

      rows.push({
        key,
        name: (L.name ?? "") as string,
        itemReference: (L.itemReference ?? "") as string,
        message: L.message ?? "",
        value,
        units,
        priority: num(H.priority),
        type: L.type ?? "",
        isAcknowledged: !!L.isAcknowledged,
        isDiscarded: !!L.isDiscarded,
        latestInsertedMs: latestOcc,
        servidorName,
        servidorHref,
        base,
        items: arr,
        _latest: L,
      });
    }
    return rows;
  }, [filteredItems, insertedMs, serverNameByBase]);

  /* =========================
     Tratativa (comentários)
     ========================= */
  type Comment = { id: string; reference: string; text: string; status?: string | null; created_at: string };
  const [autoTratativa, setAutoTratativa] = useState<Record<string, string>>({});
  const [lastStatusByRef, setLastStatusByRef] = useState<Record<string, string>>({});

  const [, setLastTextByRef] = useState<Record<string, string>>({});
  const [lastStatusAtByRef, setLastStatusAtByRef] = useState<Record<string, number>>({});
  const fetchedAtRef = useRef<Record<string, number>>({});
  const STATUS_TTL_MS = 60_000;

const COLLECTOR_HOST = import.meta.env.VITE_COLLECTOR_HOST || "localhost";
  const getVersionForBase = (baseUrl: string): string => {
    const hit = (catalogLocal as CatalogApiLoose[]).find((c) => c.BaseUrl === baseUrl)?.Versao;
    if (hit) return String(hit);
    const m = baseUrl.match(/\/api\/V?(\d+)/i);
    return m ? `V${m[1]}` : "V3";
  };
  const portFromVersion = (versao: string) => 5000 + (Number(versao.replace(/[^\d]/g, "")) || 3);
  const commentsOriginForGroup = (g: GroupRow) => `http://${COLLECTOR_HOST}:${portFromVersion(getVersionForBase(g.base))}`;
  const referenceForGroup = (g: GroupRow) => g.itemReference;

  const apiListCommentsByReference = useCallback(async (g: GroupRow, reference: string) => {
    const r = await fetch(`${commentsOriginForGroup(g)}/comments?reference=${encodeURIComponent(reference)}&pageSize=1000`);//PGSIZE
    if (!r.ok) throw new Error(`list ${r.status}`);
    return (await r.json()) as Comment[];
  }, []);
  const apiCreateComment = useCallback(async (g: GroupRow, body: { reference: string; text: string; status: string }) => {
    const r = await fetch(`${commentsOriginForGroup(g)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`create ${r.status}: ${t || "sem corpo"}`);
    return JSON.parse(t) as Comment;
  }, []);
  const apiUpdateComment = useCallback(async (g: GroupRow, id: string, patch: Partial<Pick<Comment, "text" | "status">>) => {
    const r = await fetch(`${commentsOriginForGroup(g)}/comments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`update ${r.status}: ${t || "sem corpo"}`);
    return JSON.parse(t) as Comment;
  }, []);
  const apiDeleteComment = useCallback(async (g: GroupRow, id: string) => {
    const r = await fetch(`${commentsOriginForGroup(g)}/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`delete ${r.status}`);
    return true;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pairs: Array<{ g: GroupRow; ref: string }> = [];
    const now = Date.now();
    for (const g of groupedRowsRaw) {
      const ref = referenceForGroup(g);
      if (!ref) continue;
      const lastFetched = fetchedAtRef.current[ref] ?? 0;
      if (now - lastFetched > STATUS_TTL_MS) pairs.push({ g, ref });
    }
    if (pairs.length === 0) return;

    const CONCURRENCY = 4;
    let idx = 0;
    const runNext = async (): Promise<void> => {
      if (cancelled) return;
      const i = idx++;
      if (i >= pairs.length) return;
      const { g, ref } = pairs[i];
      try {
        const list = await apiListCommentsByReference(g, ref);
        if (cancelled) return;
        const status = list[0]?.status ?? "Não tratado";
        const lastText = list[0]?.text ?? "";
        const lastAt = isoToMs(list[0]?.created_at) || 0;
        setLastStatusByRef((p) => ({ ...p, [ref]: status }));
        setLastTextByRef((p) => ({ ...p, [ref]: lastText }));
        setLastStatusAtByRef((p) => ({ ...p, [ref]: lastAt }));
        fetchedAtRef.current[ref] = Date.now();
      } catch {
        fetchedAtRef.current[ref] = Date.now();
      } finally {
        void runNext();
      }
    };
    for (let k = 0; k < Math.min(CONCURRENCY, pairs.length); k++) void runNext();
    return () => { cancelled = true; };
  }, [groupedRowsRaw, apiListCommentsByReference]);

  useEffect(() => {
    for (const g of groupedRowsRaw) {
      const ref = referenceForGroup(g);
      if (!ref) continue;
      const normalized = isNormalized(g);
      const currentPersisted = (lastStatusByRef[ref] ?? "").toLowerCase();
      const currentAuto = (autoTratativa[g.key] ?? "").toLowerCase();
      const lastAt = lastStatusAtByRef[ref] ?? 0;
      const hasNewAlarm = (g.latestInsertedMs || 0) > lastAt;

      if (normalized) {
        if (currentAuto !== "concluído" && currentAuto !== "concluido") setAutoTratativa((p) => ({ ...p, [g.key]: "Concluído" }));
        continue;
      }

      const wasClosedOrWorking =
        ["concluído", "concluido", "em andamento", "oportunidade"].includes(currentPersisted) ||
        ["concluído", "concluido", "em andamento", "oportunidade"].includes(currentAuto);

      if (hasNewAlarm && wasClosedOrWorking) {
        if (currentAuto !== "não tratado") setAutoTratativa((p) => ({ ...p, [g.key]: "Não tratado" }));
      }
    }
  }, [groupedRowsRaw, lastStatusByRef, lastStatusAtByRef, autoTratativa]);

  const statusShownForGroup = useCallback((g: GroupRow) => {
    const ref = g.itemReference ?? "";
    if (isNormalized(g)) return "Concluído";
    return lastStatusByRef[ref] ?? autoTratativa[g.key] ?? "Não tratado";
  }, [autoTratativa, lastStatusByRef]);

  /* =========================
     Data Loading (parcial + erros)
     ========================= */
  const addApiError = useCallback((e: ErrorEntry) => {
    setApiErrors((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e]));
  }, []);
  const clearApiErrors = useCallback(() => setApiErrors([]), []);

  const reload = useCallback(async () => {
  // cancela rodada anterior
  inflightAbort.current?.abort();
  const ac = new AbortController();
  inflightAbort.current = ac;

  try {
    setLoading(true);
    setError(null);
    clearApiErrors();
    bufferRef.current = [];
  
    // 1) catálogo
    const catalog = await fetchCatalog();
    const nextItems: AlarmItem[] = []; // TESTE
    setCatalogLocal(catalog as CatalogApiLoose[]);

    const nameBy: Record<string, string> = {};
    const offBy: Record<string, number> = {};
    for (const a of catalog as CatalogApiLoose[]) {
      nameBy[a.BaseUrl] = a.Servidor || a.BaseUrl.replace(/^https?:\/\//, "");
      offBy[a.BaseUrl] = a.offset ?? 0;
    }
    setServerNameByBase(nameBy);
    setOffsetByBase(offBy);

    // 2) pipeline paralelo login->collect
    const limit = pLimit(10);
    const jobs = (catalog as CatalogApiLoose[]).map(api => limit(async () => {
      if (ac.signal.aborted) return;
      try {
        const token = await getTokenCached(api.BaseUrl, api.Usuario, api.Senha);
        if (ac.signal.aborted) return;
        const session: Session = {
          base_url: api.BaseUrl,
          token,
          offset: api.offset ?? 0,
          servidor: api.Servidor,
          pageSize: Math.max(1, api.QuantidadeAlarmes || 1),
          page: 1,
          verify_ssl: false,
        };
        const chunk = await collectAlarmsBatch([session], ac.signal);
        if (ac.signal.aborted) return;
        // pushChunk(chunk); TESTE
        nextItems.push(...chunk);

      } catch (e: any) {
        if (ac.signal.aborted) return;
        addApiError({
          id: `${api.BaseUrl}::pipeline`,
          title: "Falha na coleta",
          details: e?.message ?? String(e),
        });
      }
    }));

    await Promise.allSettled(jobs);
    setItems(nextItems);

  } catch (e: any) {
    if (!/AbortError/i.test(String(e?.name))) setError(e?.message ?? String(e));
  } finally {
    setLoading(false);
    setNextTs(Date.now() + REFRESH_MS);
  }
}, [clearApiErrors, addApiError]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const id = setInterval(() => {
      const msLeft = Math.max(0, nextTs - Date.now());
      const s = Math.ceil(msLeft / 1000);
      setLeftSec(s);
      if (msLeft <= 0 && !loading) void reload();
    }, 1000);
    return () => clearInterval(id);
  }, [nextTs, loading, reload]);

  /* =========================
     Sorting / Filtering
     ========================= */
  const groupedSortedBase = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const keyFn = (k: SortKey, it: GroupRow) => {
      switch (k) {
        case "servidor": return it.servidorName || "";
        case "name": return it.name || "";
        case "itemReference": return it.itemReference || "";
        case "message": return it.message || "";
        case "value": return num(it.value) ?? Number.NEGATIVE_INFINITY;
        case "priority": return num(it.priority) ?? Number.NEGATIVE_INFINITY;
        case "type": return it.type || "";
        case "isAcknowledged": return it.isAcknowledged ? 1 : 0;
        case "isDiscarded": return it.isDiscarded ? 1 : 0;
        case "inserido": return it.latestInsertedMs || 0;
        case "tratativa": {
          const ref = it.itemReference ?? "";
          if (isNormalized(it)) return "Concluído";
          return lastStatusByRef[ref] ?? autoTratativa[it.key] ?? "Não tratado";
        }
      }
    };
    return [...groupedRowsRaw].sort((a, b) => {
      const ka = keyFn(sortKey, a) as any, kb = keyFn(sortKey, b) as any;
      if (typeof ka === "number" && typeof kb === "number") return ka === kb ? 0 : ka < kb ? -dir : dir;
      const cmp = String(ka).localeCompare(String(kb));
      if (cmp !== 0) return cmp * dir;
      const pA = num(a.priority) ?? -Infinity, pB = num(b.priority) ?? -Infinity;
      if (pA !== pB) return pB - pA;
      return (b.latestInsertedMs ?? 0) - (a.latestInsertedMs ?? 0);
    });
  }, [groupedRowsRaw, sortKey, sortDir, lastStatusByRef, autoTratativa]);

  const groupedSorted = useMemo(() => {
    if (!fTratativas.length) return groupedSortedBase;
    return groupedSortedBase.filter((g) => fTratativas.includes(statusShownForGroup(g)));
  }, [groupedSortedBase, fTratativas, statusShownForGroup]);

  const total = items.length, totalShown = groupedSorted.length;

  const clearFilters = () => {
    setFServidores([]); setFTipos([]); setFTratativas([]);
    setFNome(""); setFItemRef(""); setFMensagem(""); setFValorTxt("");
    setFPriorMin(""); setFPriorMax(""); setFAck(""); setFDesc("");
    setFInsDe(""); setFInsAte("");
  };

  const setSort = (k: SortKey, d: "asc" | "desc") => { setSortKey(k); setSortDir(d); };

  const computeBellColor = (g: GroupRow): "red" | "gray" | "green" | "yellow" => {
    const L = g._latest as any;
    const type = String(L?.type ?? g.type ?? "").toLowerCase();
    const val = String(L?.triggerValue_value ?? L?.triggerValue?.value ?? g.value ?? "").toLowerCase();
    if (type.includes("alarm") || type.includes("unreliable")) return "red";
    if (val.includes("offline")) return "gray";
    if (type.includes("normal") || val.includes("online")) return "green";
    return "yellow";
  };

  const Bell = ({ color }: { color: "red" | "gray" | "green" | "yellow" }) => (
    <span className={`bell bell--${color}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6V11a6 6 0 1 0-12 0v5l-2 2v1h16v-1l-2-2Z"/></svg>
    </span>
  );

  const headerCell = (label: string, key: SortKey) => (
    <th key={key} className="th" title={`Ordenar por ${label}`}>
      <span className="th__inner">
        <span>{label}</span>
        <span className="th__sort">
          <button onClick={() => setSort(key, "asc")} className={`btn btn--ghost ${sortKey === key && sortDir === "asc" ? "btn--active" : ""}`}>▲</button>
          <button onClick={() => setSort(key, "desc")} className={`btn btn--ghost ${sortKey === key && sortDir === "desc" ? "btn--active" : ""}`}>▼</button>
        </span>
      </span>
    </th>
  );

  /* =========================
     Filtros (modais)
     ========================= */
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [tratModalOpen, setTratModalOpen] = useState(false);
  const [tempServidores, setTempServidores] = useState<string[]>([]);
  const [tempTipos, setTempTipos] = useState<string[]>([]);
  const [tempTrat, setTempTrat] = useState<string[]>([]);
  const [serverSearch, setServerSearch] = useState("");
  const [typeSearch, setTypeSearch] = useState("");
  const [tratSearch, setTratSearch] = useState("");

  const filteredServerOpts = useMemo(() => uniqServidores.filter((s) => s.toLowerCase().includes(serverSearch.toLowerCase())), [uniqServidores, serverSearch]);
  const filteredTypeOpts   = useMemo(() => uniqTipos.filter((s) => s.toLowerCase().includes(typeSearch.toLowerCase())), [uniqTipos, typeSearch]);
  const filteredTratOpts   = useMemo(() => lanes.filter((s) => s.toLowerCase().includes(tratSearch.toLowerCase())), [tratSearch]);

  const toggleTemp = (arr: string[], setArr: (v: string[]) => void, v: string) =>
    setArr(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  /* =========================
     CRUD APIs + Testar
     ========================= */
  const openApisModal = async () => {
    setApisError(null); setApisNotice(null); setForm(emptyForm); setEditingId(null);
    try { setApisBusy(true); setCatalogLocal(await fetchCatalog() as CatalogApiLoose[]); setApisOpen(true); }
    catch (e: any) { setApisError(e?.message ?? String(e)); }
    finally { setApisBusy(false); }
  };
  const startCreate = () => { setEditingId(null); setForm(emptyForm); };
  const startEdit = (api: CatalogApiLoose) => {
    const editing = getApiId(api);
    setEditingId(editing);
    setForm({
      Servidor: api.Servidor ?? "", IP: api.IP ?? "", Usuario: api.Usuario ?? "",
      offset: Number(api.offset ?? 0), Versao: String(api.Versao ?? "V3"),
      QuantidadeAlarmes: Number(api.QuantidadeAlarmes ?? 1), Senha: api.Senha ?? "",
    });
  };
  const saveApi = async () => {
    try {
      setApisBusy(true); setApisError(null); setApisNotice(null);
      const payload = {
        Servidor: form.Servidor.trim(), IP: form.IP.trim(), Usuario: form.Usuario.trim(),
        offset: Math.max(-12, Math.min(12, Number(form.offset ?? 0))),
        Versao: (form.Versao || "V3").toUpperCase(),
        QuantidadeAlarmes: Math.max(1, Number(form.QuantidadeAlarmes ?? 1)),
        Senha: form.Senha ?? "",
      };
      if (editingId) await updateApi(editingId, payload); else await createApi(payload);
      const list = await fetchCatalog(); setCatalogLocal(list as CatalogApiLoose[]); startCreate();
      setApisNotice("Registro salvo."); setTimeout(() => setApisNotice(null), 2500);
      await reload();
    } catch (e: any) { setApisError(e?.message ?? String(e)); }
    finally { setApisBusy(false); }
  };
  const removeApi = async (id: string | null) => {
    if (!id) return; if (!confirm("Excluir esta API do catálogo?")) return;
    try { setApisBusy(true); setApisError(null); setApisNotice(null);
      await deleteApi(id); setCatalogLocal(await fetchCatalog() as CatalogApiLoose[]);
      setApisNotice("API removida."); setTimeout(() => setApisNotice(null), 2500); await reload();
    } catch (e: any) { setApisError(e?.message ?? String(e)); }
    finally { setApisBusy(false); }
  };
  const testApi = async (api: CatalogApiLoose) => {
    const id = getApiId(api) || `${api.Servidor}-${api.IP}-${api.Versao}`;
    setTestBusyById((p) => ({ ...p, [id]: true })); setApisError(null); setApisNotice(null);
    try {
      const token = await loginAndGetToken({ base_url: api.BaseUrl, usuario: api.Usuario, senha: api.Senha, verify_ssl: false });
      if (token) { setApisNotice(`API online (${api.BaseUrl})`); setTimeout(() => setApisNotice(null), 2500); }
      else setApisError(`Sem token ao testar ${api.BaseUrl}.`);
    } catch (e: any) { setApisError(`Falha no teste de ${api.BaseUrl}: ${e?.message ?? String(e)}`); }
    finally { setTestBusyById((p) => ({ ...p, [id]: false })); }
  };

  /* =========================
     Tratativa — Modal de edição
     ========================= */
  const [tratativaModal, setTratativaModal] = useState<{
    open: boolean;
    group: GroupRow | null;
    comments: Comment[];
    busy: boolean;
    error: string | null;
    text: string;
    status: string;
    editingId: string | null;
  }>({ open: false, group: null, comments: [], busy: false, error: null, text: "", status: "Não tratado", editingId: null });

  const openTratativaModal = async (g: GroupRow) => {
    const reference = g.itemReference; if (!reference) return;
    setTratativaModal((s) => ({ ...s, open: true, group: g, busy: true, error: null, comments: [], text: "", editingId: null, status: "Não tratado" }));
    try {
      const comments = await apiListCommentsByReference(g, reference);
      if (comments[0]?.status) setLastStatusByRef((p) => ({ ...p, [reference]: String(comments[0].status) }));
      if (comments[0]?.text)   setLastTextByRef((p) => ({ ...p, [reference]: String(comments[0].text) }));
      if (comments[0]?.created_at) setLastStatusAtByRef((p) => ({ ...p, [reference]: isoToMs(comments[0].created_at) || 0 }));
      setTratativaModal((s) => ({
        ...s,
        open: true,
        group: g,
        comments,
        busy: false,
        error: null,
        text: "",
        status: isNormalized(g) ? "Concluído" : comments[0]?.status ?? autoTratativa[g.key] ?? "Não tratado",
        editingId: null
      }));
    } catch (e: any) {
      setTratativaModal((s) => ({ ...s, busy: false, error: e?.message ?? String(e) }));
    }
  };

  const onSaveTratativa = async () => {
    const m = tratativaModal; if (!m.group) return;
    const reference = m.group.itemReference;
    if (!reference) { setTratativaModal((s) => ({ ...s, error: "Este grupo não possui itemReference para usar como reference." })); return; }
    try {
      setTratativaModal((s) => ({ ...s, busy: true, error: null }));
      if (m.editingId) {
        const up = await apiUpdateComment(m.group, m.editingId, { text: m.text, status: m.status });
        setLastTextByRef((p) => ({ ...p, [reference]: up.text })); if (up.status) setLastStatusByRef((p) => ({ ...p, [reference]: String(up.status) }));
      } else {
        const created = await apiCreateComment(m.group, { reference, text: m.text || "(sem texto)", status: m.status });
        setLastTextByRef((p) => ({ ...p, [reference]: created.text })); if (created.status) setLastStatusByRef((p) => ({ ...p, [reference]: String(created.status) }));
      }
      const comments = await apiListCommentsByReference(m.group, reference);
      setTratativaModal((s) => ({ ...s, comments, text: "", editingId: null, busy: false, status: comments[0]?.status ?? m.status }));
      if (comments[0]?.status) setLastStatusByRef((p) => ({ ...p, [reference]: String(comments[0].status) }));
      if (comments[0]?.created_at) setLastStatusAtByRef((p) => ({ ...p, [reference]: isoToMs(comments[0]?.created_at) || 0 }));
      setAutoTratativa((p) => ({ ...p, [m.group!.key]: comments[0]?.status ?? m.status }));
    } catch (e: any) {
      setTratativaModal((s) => ({ ...s, busy: false, error: e?.message ?? String(e) }));
    }
  };

  const onEditComment = (c: Comment) => setTratativaModal((s) => ({ ...s, editingId: c.id, text: c.text, status: c.status ?? "Não tratado" }));
  const onDeleteComment = async (c: Comment) => {
    const m = tratativaModal; if (!m.group) return;
    if (!confirm("Excluir este comentário?")) return;
    try {
      setTratativaModal((s) => ({ ...s, busy: true, error: null }));
      await apiDeleteComment(m.group, c.id);
      const reference = m.group.itemReference;
      const comments = reference ? await apiListCommentsByReference(m.group, reference) : [];
      setTratativaModal((s) => ({ ...s, comments, busy: false, editingId: null, text: "" }));
      if (reference) {
        const newStatus = comments[0]?.status ?? (isNormalized(m.group!) ? "Concluído" : autoTratativa[m.group!.key] ?? "Não tratado");
        setLastStatusByRef((p) => ({ ...p, [reference]: newStatus }));
        setLastTextByRef((p) => ({ ...p, [reference]: comments[0]?.text ?? "" }));
        setLastStatusAtByRef((p) => ({ ...p, [reference]: isoToMs(comments[0]?.created_at) || 0 }));
      }
    } catch (e: any) {
      setTratativaModal((s) => ({ ...s, busy: false, error: e?.message ?? String(e) }));
    }
  };

  const statusBtnClass = (status: string) => {
    const s = (status || "").toLowerCase();
    if (s === "em andamento") return "btn--status st-progress";
    if (s === "concluído" || s === "concluido") return "btn--status st-done";
    if (s === "oportunidade") return "btn--status st-opportunity";
    return "btn--status st-not";
  };

  /* =========================
     Kanban (drag & drop + autoscroll)
     ========================= */
  const kanbanWrapRef = useRef<HTMLDivElement | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const groupByKey = useMemo(() => {
    const m = new Map<string, GroupRow>();
    for (const g of groupedSorted) m.set(g.key, g);
    return m;
  }, [groupedSorted]);

  const onKanbanDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    const wrap = kanbanWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const t = 60;
    if (e.clientY > rect.bottom - t) wrap.scrollTop += 18;
    else if (e.clientY < rect.top + t) wrap.scrollTop -= 18;
  };

  const onDropLane = async (lane: Lane) => {
    if (!dragKey) return;
    const g = groupByKey.get(dragKey);
    setDragKey(null);
    if (!g || statusShownForGroup(g) === lane) return;
    const ref = g.itemReference;
    setAutoTratativa((p) => ({ ...p, [g.key]: lane }));
    setLastStatusByRef((p) => ({ ...p, [ref]: lane }));
    setLastStatusAtByRef((p) => ({ ...p, [ref]: Date.now() }));
    try { await apiCreateComment(g, { reference: ref, text: "(ajustado via Kanban)", status: lane }); } catch {}
  };

  // === Kanban ===
  const renderKanban = () => {
    const byLane: Record<Lane, GroupRow[]> = { "Não tratado": [], "Em andamento": [], "Concluído": [], "Oportunidade": [] };
    for (const g of groupedSorted) byLane[statusShownForGroup(g) as Lane]?.push(g);

    return (
      <div className="tableWrap" ref={kanbanWrapRef} onDragOver={onKanbanDragOver}>
        <div className="kanban">
          {lanes.map((ln) => (
            <div key={ln} className="kanban__col" onDragOver={(e) => e.preventDefault()} onDrop={() => onDropLane(ln)}>
              <div className="kanban__colHeader">
                <strong>{ln}</strong>
                <span className="badge">{byLane[ln].length}</span>
              </div>
              <div className="kanban__colBody">
                {byLane[ln].map((g) => {
                  const bell = computeBellColor(g);
                  const val = g.value ?? "";
                  const un = g.units ?? "";
                  const status = statusShownForGroup(g);

                  return (
                    <div
                      key={g.key}
                      className={`kanban__card ${dragKey === g.key ? "kanban__card--dragging" : ""}`}
                      draggable
                      onDragStart={() => setDragKey(g.key)}
                      onDragEnd={() => setDragKey(null)}
                      style={{ position: "relative" }}
                    >
                      {/* Contador de ocorrências */}
                      <button
                        className="badge badge--count"
                        style={{ position: "absolute", top: 8, right: 8, cursor: "pointer" }}
                        title={`Ver ${g.items.length} ocorrências`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); setModalGroup(g); }}
                      >
                        x{g.items.length}
                      </button>

                      {/* Cabeçalho: sino + servidor */}
                      <div className="kanban__cardHead">
                        <Bell color={bell} />
                        <span className="muted">{g.servidorName || "—"}</span>
                      </div>

                      {/* Título */}
                      <div className="kanban__cardTitle" style={{ marginRight: 40 }}>
                        <strong title={g.name || ""}>{g.name || g.itemReference || "(sem nome)"}</strong>
                      </div>

                      <div className="kanban__cardMeta">
                        {(() => {
                          const refFull = g.itemReference || "—";
                          const refShort = clip(refFull, 35);
                          return <span className="muted" title={refFull}>{refShort}</span>;
                        })()}
                        <span className="pill">{String(val)} {String(un)}</span>
                      </div>


                      {/* Mensagem */}
                      {g.message && <div className="kanban__cardBody muted">{g.message}</div>}

                      {/* Ação / Status */}
                      <div className="kanban__cardActions">
                        <button
                          className={`btn ${statusBtnClass(status)}`}
                          title="Ver/editar tratativa"
                          onMouseDown={(e) => { e.stopPropagation(); }}
                          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                          draggable={false}
                          onClick={() => openTratativaModal(g)}
                        >
                          {status}
                        </button>
                      </div>
                      {/* Data da última ocorrência */}
                      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{msToDMYTime(g.latestInsertedMs)}</div>
                    </div>
                  );
                })}
                {byLane[ln].length === 0 && <div className="muted" style={{ padding: 6 }}>—</div>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  /* =========================
     Render
     ========================= */
  const manualReload = () => { setNextTs(Date.now() + REFRESH_MS); void reload(); };

  return (
    <div className="page">
      {/* AppBar */}
      <div className="appbar">
        <div className="appbar__title">MANAGE ALARM VIEWER</div>
        <div className="appbar__actions">
          <button onClick={manualReload} disabled={loading} className="btn btn--primary" title={`Recarregar agora • próximo automático em ${fmtMMSS(leftSec)}`}>
            🔄 Recarregar ({fmtMMSS(leftSec)})
          </button>
          <button className="btn" onClick={() => setView((v) => (v === "table" ? "kanban" : "table"))} title="Alternar entre Tabela e Kanban">
            {view === "table" ? "Kanban" : "Tabela"}
          </button>
          <button onClick={openApisModal} className="btn " title="Gerenciar APIs">🧰 API's</button>
          <button onClick={clearFilters} className="btn" title="Limpar filtros">🧹 Limpar filtros</button>
          {apiErrors.length === 0 ? (
            <button className="btn" disabled title="Sem erros detectados">✅ Online</button>
          ) : (
            apiErrors.map((e) => (
              <button key={e.id} className="btn btn--danger" onClick={() => setErrorModal({ open: true, entry: e })} title="Clique para ver detalhes do erro">
                {e.title}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Top info */}
      <div className="topbar topbar--subtle">
        <div className="muted">{loading ? "Carregando..." : `Total: ${total} · Exibindo grupos: ${totalShown}`}</div>
        {error && <div className="error">Erro: {error}</div>}
      </div>

      {/* Tabela ou Kanban */}
      {view === "kanban" ? (
        renderKanban()
      ) : (
        <div className="tableWrap">
          <div className="tableCard">
            <table className="table">
              <thead>
                <tr className="thead-title">
                  {headerCell("Servidor", "servidor")}
                  {headerCell("Nome", "name")}
                  {headerCell("Referência", "itemReference")}
                  {headerCell("Mensagem", "message")}
                  {headerCell("Valor", "value")}
                  {headerCell("Prioridade", "priority")}
                  {headerCell("Tipo", "type")}
                  {headerCell("Reconhecido", "isAcknowledged")}
                  {headerCell("Descartado", "isDiscarded")}
                  {headerCell("Inserido", "inserido")}
                  {headerCell("Tratativa", "tratativa")}
                </tr>
                <tr className="thead-filters">
                  <th className="th">
                    <button type="button" className="input" onClick={() => { setTempServidores([...fServidores]); setServerSearch(""); setServerModalOpen(true); }}
                      title="Clique para filtrar por Servidor" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontWeight: 600 }} className="muted">Servidor:</span>
                      <span>{summarize(fServidores, uniqServidores.length)}</span>
                    </button>
                  </th>
                  <th className="th"><input value={fNome} onChange={(e) => setFNome(e.target.value)} placeholder="contém…" className="input" /></th>
                  <th className="th"><input value={fItemRef} onChange={(e) => setFItemRef(e.target.value)} placeholder="contém…" className="input" /></th>
                  <th className="th"><input value={fMensagem} onChange={(e) => setFMensagem(e.target.value)} placeholder="contém…" className="input" /></th>
                  <th className="th"><input value={fValorTxt} onChange={(e) => setFValorTxt(e.target.value)} placeholder="ex.: 22.5 °C" className="input" /></th>
                  <th className="th">
                    <div className="grid2">
                      <input value={fPriorMin} onChange={(e) => setFPriorMin(e.target.value)} placeholder="min" className="input" inputMode="numeric" />
                      <input value={fPriorMax} onChange={(e) => setFPriorMax(e.target.value)} placeholder="max" className="input" inputMode="numeric" />
                    </div>
                  </th>
                  <th className="th">
                    <button type="button" className="input" onClick={() => { setTempTipos([...fTipos]); setTypeSearch(""); setTypeModalOpen(true); }}
                      title="Clique para filtrar por Tipo" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontWeight: 600 }} className="muted">Tipo:</span>
                      <span>{summarize(fTipos, uniqTipos.length)}</span>
                    </button>
                  </th>
                  <th className="th">
                    <select value={fAck} onChange={(e) => setFAck(e.target.value)} className="input select">
                      <option value="">(Todos)</option><option value="sim">Sim</option><option value="nao">Não</option>
                    </select>
                  </th>
                  <th className="th">
                    <select value={fDesc} onChange={(e) => setFDesc(e.target.value)} className="input select">
                      <option value="">(Todos)</option><option value="sim">Sim</option><option value="nao">Não</option>
                    </select>
                  </th>
                  <th className="th">
                    <div className="grid2">
                      <input type="date" value={fInsDe} onChange={(e) => setFInsDe(e.target.value)} className="input" />
                      <input type="date" value={fInsAte} onChange={(e) => setFInsAte(e.target.value)} className="input" />
                    </div>
                  </th>
                  <th className="th">
                    <button type="button" className="input" onClick={() => { setTempTrat([...fTratativas]); setTratSearch(""); setTratModalOpen(true); }}
                      title="Clique para filtrar por Tratativa" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontWeight: 600 }} className="muted">Tratativa:</span>
                      <span>{summarize(fTratativas, lanes.length)}</span>
                    </button>
                  </th>
                </tr>
              </thead>

              <tbody>
                {groupedSorted.map((g) => {
                  const val = g.value ?? "";
                  const un = g.units ?? "";
                  const link = g.servidorHref;
                  const bell = computeBellColor(g);
                  const status = statusShownForGroup(g);
                  return (
                    <tr key={g.key}>
                        <td className="td">

                        {/* <td className="td td--servidor"></td> */}
                          <span title="status"><Bell color={bell} /></span>
                          {link ? (
                            <a href={link} target="_blank" rel="noreferrer" className="link" title={g.servidorName}>
                              {g.servidorName || "—"}
                            </a>
                          ) : (g.servidorName || "—")}

                        </td>
                      <td className="td">
                        <strong title={g.name || ""}>{g.name || g.itemReference || "(sem nome)"}</strong>{" "}
                        <br></br>
                        {g.items.length > 1 && (
                          <button
                            className="badge badge--count"
                            style={{ cursor: "pointer" }}
                            title={`Ver ${g.items.length} ocorrências`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); setModalGroup(g); }}
                          >
                            x{g.items.length}
                          </button>
                        )}
                      </td>

                      <td className="td" title={g.itemReference}>{g.itemReference || "—"}</td>
                      <td className="td" title={g.message}>{g.message ?? ""}</td>
                      <td className="td">{String(val)} {String(un)}</td>
                      <td className="td td--center">{g.priority ?? "—"}</td>
                      <td className="td">{g.type ?? "—"}</td>
                      <td className="td td--center">{g.isAcknowledged ? "✔" : "—"}</td>
                      <td className="td td--center">{g.isDiscarded ? "✔" : "—"}</td>
                      <td className="td td--nowrap">{msToDMYTime(g.latestInsertedMs)}</td>
                      <td className="td">
                        <button className={`btn ${statusBtnClass(status)}`} title="Ver/editar tratativa" onClick={() => openTratativaModal(g)}>{status}</button>
                      </td>
                    </tr>
                  );
                })}
                {!loading && groupedSorted.length === 0 && (
                  <tr><td className="td td--center" colSpan={11}>Nenhum item encontrado com os filtros atuais.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {error && <div className="error" style={{ marginTop: 12 }}>Erro: {error}</div>}
        </div>
      )}

      {/* Modal: detalhes do grupo */}
      {modalGroup && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setModalGroup(null)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title">
                <strong>{modalGroup.name || "(sem nome)"}</strong>
                <div className="muted" style={{ marginTop: 4 }}>{modalGroup.itemReference}</div>
              </div>
              <button className="modal__close" onClick={() => setModalGroup(null)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div className="tableCard">
                <table className="table">
                  <thead>
                    <tr className="thead-title">
                      <th className="th"><span className="th__inner"><span>Servidor</span></span></th>
                      <th className="th"><span className="th__inner"><span>Mensagem</span></span></th>
                      <th className="th"><span className="th__inner"><span>Valor</span></span></th>
                      <th className="th"><span className="th__inner"><span>Prioridade</span></span></th>
                      <th className="th"><span className="th__inner"><span>Tipo</span></span></th>
                      <th className="th"><span className="th__inner"><span>Reconhecido</span></span></th>
                      <th className="th"><span className="th__inner"><span>Descartado</span></span></th>
                      <th className="th"><span className="th__inner"><span>Ocorrência</span></span></th>
                      <th className="th"><span className="th__inner"><span>Abrir</span></span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...modalGroup.items]
                      .sort((a, b) => insertedMs(b) - insertedMs(a))
                      .map((it, idx) => {
                        const base = (it as any).source_base_url ?? (it as any).__source_base_url ?? "";
                        const srv = serverNameByBase[base] ?? base.replace(/^https?:\/\//, "");
                        const v = (it as any).triggerValue_value ?? (it as any).triggerValue?.value ?? "";
                        const u = (it as any).triggerValue_units ?? (it as any).triggerValue?.units ?? "";
                        const href = base ? toUiLink(base) : "";
                        const occDisp = msToDMYTime(occurrenceMsWithOffset(it));
                        return (
                          <tr key={`${idx}-${(it as any).id ?? "id"}`}>
                            <td className="td">{srv || "—"}</td>
                            <td className="td">{(it as any).message ?? ""}</td>
                            <td className="td">{`${v} ${u}`}</td>
                            <td className="td td--center">{(it as any).priority ?? "—"}</td>
                            <td className="td">{(it as any).type ?? "—"}</td>
                            <td className="td td--center">{(it as any).isAcknowledged ? "✔" : "—"}</td>
                            <td className="td td--center">{(it as any).isDiscarded ? "✔" : "—"}</td>
                            <td className="td">{occDisp}</td>
                            <td className="td">{href ? <a href={href} target="_blank" rel="noreferrer" className="link">Abrir</a> : "—"}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modais de filtro */}
      {serverModalOpen && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setServerModalOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header"><div className="modal__title"><strong>Filtrar por Servidor</strong></div>
              <button className="modal__close" onClick={() => setServerModalOpen(false)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input className="input" placeholder="Buscar servidor..." value={serverSearch} onChange={(e) => setServerSearch(e.target.value)} />
                <button className="btn btn--ghost" onClick={() => setTempServidores([...uniqServidores])}>Selecionar todos</button>
                <button className="btn btn--ghost" onClick={() => setTempServidores([])}>Limpar</button>
              </div>
              <div className="tableCard" style={{ padding: 8 }}>
                <div style={{ maxHeight: 320, overflow: "auto", display: "grid", gap: 6 }}>
                  {filteredServerOpts.map((opt) => (
                    <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={tempServidores.includes(opt)} onChange={() => toggleTemp(tempServidores, setTempServidores, opt)} />
                      <span>{opt}</span>
                    </label>
                  ))}
                  {filteredServerOpts.length === 0 && <div className="muted">Nenhum servidor encontrado.</div>}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={() => setServerModalOpen(false)}>Cancelar</button>
                <button className="btn btn--primary" onClick={() => { setFServidores(tempServidores); setServerModalOpen(false); }}>Aplicar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {typeModalOpen && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setTypeModalOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header"><div className="modal__title"><strong>Filtrar por Tipo</strong></div>
              <button className="modal__close" onClick={() => setTypeModalOpen(false)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input className="input" placeholder="Buscar tipo..." value={typeSearch} onChange={(e) => setTypeSearch(e.target.value)} />
                <button className="btn btn--ghost" onClick={() => setTempTipos([...fTipos.length ? fTipos : uniqTipos])}>Selecionar todos</button>
                <button className="btn btn--ghost" onClick={() => setTempTipos([])}>Limpar</button>
              </div>
              <div className="tableCard" style={{ padding: 8 }}>
                <div style={{ maxHeight: 320, overflow: "auto", display: "grid", gap: 6 }}>
                  {filteredTypeOpts.map((opt) => (
                    <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={tempTipos.includes(opt)} onChange={() => toggleTemp(tempTipos, setTempTipos, opt)} />
                      <span>{opt}</span>
                    </label>
                  ))}
                  {filteredTypeOpts.length === 0 && <div className="muted">Nenhum tipo encontrado.</div>}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={() => setTypeModalOpen(false)}>Cancelar</button>
                <button className="btn btn--primary" onClick={() => { setFTipos(tempTipos); setTypeModalOpen(false); }}>Aplicar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {tratModalOpen && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setTratModalOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header"><div className="modal__title"><strong>Filtrar por Tratativa</strong></div>
              <button className="modal__close" onClick={() => setTratModalOpen(false)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input className="input" placeholder="Buscar status..." value={tratSearch} onChange={(e) => setTratSearch(e.target.value)} />
                <button className="btn btn--ghost" onClick={() => setTempTrat([...lanes])}>Selecionar todos</button>
                <button className="btn btn--ghost" onClick={() => setTempTrat([])}>Limpar</button>
              </div>
              <div className="tableCard" style={{ padding: 8 }}>
                <div style={{ maxHeight: 320, overflow: "auto", display: "grid", gap: 6 }}>
                  {filteredTratOpts.map((opt) => (
                    <label key={opt} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input type="checkbox" checked={tempTrat.includes(opt)} onChange={() => toggleTemp(tempTrat, setTempTrat, opt)} />
                      <span>{opt}</span>
                    </label>
                  ))}
                  {filteredTratOpts.length === 0 && <div className="muted">Nenhum status encontrado.</div>}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={() => setTratModalOpen(false)}>Cancelar</button>
                <button className="btn btn--primary" onClick={() => { setFTratativas(tempTrat); setTratModalOpen(false); }}>Aplicar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Gerenciar APIs */}
      {apisOpen && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setApisOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title">
                <strong>Catálogo de APIs</strong>
                <span className="muted" style={{ fontSize: 12 }}>Listar · Cadastrar · Editar · Excluir · Testar</span>
              </div>
              <button className="modal__close" onClick={() => setApisOpen(false)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              {apisError && <div className="error" style={{ marginBottom: 8 }}>{apisError}</div>}
              {apisNotice && <div className="notice" style={{ marginBottom: 8 }}>{apisNotice}</div>}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 12 }}>
                <input className="input" placeholder="Servidor" value={form.Servidor} onChange={(e) => setForm((f) => ({ ...f, Servidor: e.target.value }))} />
                <input className="input" placeholder="IP (ex.: 10.2.1.133)" value={form.IP} onChange={(e) => setForm((f) => ({ ...f, IP: e.target.value }))} inputMode="numeric" />
                <select className="input select" value={form.Versao} onChange={(e) => setForm((f) => ({ ...f, Versao: e.target.value }))}>
                  {["V1", "V2", "V3", "V4", "V5", "V6"].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                <input className="input" placeholder="Qtd Alarmes" inputMode="numeric" value={String(form.QuantidadeAlarmes)} onChange={(e) => setForm((f) => ({ ...f, QuantidadeAlarmes: Number(e.target.value || 1) }))} />
                <input className="input" placeholder="Usuário" value={form.Usuario} onChange={(e) => setForm((f) => ({ ...f, Usuario: e.target.value }))} />
                <input className="input" placeholder="Senha" type="password" value={form.Senha} onChange={(e) => setForm((f) => ({ ...f, Senha: e.target.value }))} />
                <div style={{ gridColumn: "span 6 / auto" }}>
                  <label className="muted" style={{ display: "block", marginBottom: 4 }}>Offset (h)</label>
                  <select className="input select" value={String(form.offset)} onChange={(e) => setForm((f) => ({ ...f, offset: Number(e.target.value) }))}>
                    {Array.from({ length: 25 }, (_, i) => i - 12).map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                {editingId ? (
                  <>
                    <button className="btn btn--primary" disabled={apisBusy} onClick={saveApi}>💾 Salvar</button>
                    <button className="btn" disabled={apisBusy} onClick={startCreate}>➕ Novo</button>
                  </>
                ) : (
                  <button className="btn btn--primary" disabled={apisBusy} onClick={saveApi}>➕ Cadastrar</button>
                )}
              </div>

              <div className="tableCard">
                <table className="table">
                  <thead>
                    <tr className="thead-title">
                      <th className="th"><span className="th__inner"><span>Servidor</span></span></th>
                      <th className="th"><span className="th__inner"><span>IP</span></span></th>
                      <th className="th"><span className="th__inner"><span>Versão</span></span></th>
                      <th className="th"><span className="th__inner"><span>Qtd</span></span></th>
                      <th className="th"><span className="th__inner"><span>Usuário</span></span></th>
                      <th className="th"><span className="th__inner"><span>Senha</span></span></th>
                      <th className="th"><span className="th__inner"><span>Offset</span></span></th>
                      <th className="th"><span className="th__inner"><span>Link</span></span></th>
                      <th className="th"><span className="th__inner"><span>BaseUrl</span></span></th>
                      <th className="th"><span className="th__inner"><span>Ações</span></span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalogLocal.map((api) => {
                      const id = getApiId(api) || `${api.Servidor}-${api.IP}-${api.Versao}`;
                      return (
                        <tr key={id}>
                          <td className="td">{api.Servidor ?? "—"}</td>
                          <td className="td">{api.IP ?? "—"}</td>
                          <td className="td td--center">{api.Versao ?? "—"}</td>
                          <td className="td td--center">{api.QuantidadeAlarmes ?? 0}</td>
                          <td className="td">{api.Usuario ?? "—"}</td>
                          <td className="td" title="ocultado">{mask(api.Senha)}</td>
                          <td className="td td--center">{api.offset ?? 0}</td>
                          <td className="td">{api.Link ? <a className="link" href={api.Link} target="_blank" rel="noreferrer">Abrir</a> : "—"}</td>
                          <td className="td">{api.BaseUrl ?? "—"}</td>
                          <td className="td td--nowrap">
                            <button className="btn btn--ghost" onClick={() => startEdit(api)}>✏️ Editar</button>{" "}
                            <button className="btn btn--ghost" onClick={() => removeApi(getApiId(api))} disabled={!getApiId(api)}>🗑️ Excluir</button>{" "}
                            <button className="btn btn--secondary" onClick={() => testApi(api)} disabled={!!testBusyById[id] || apisBusy} title="Testar conexão e login">
                              {testBusyById[id] ? "🔎 Testando..." : "🧪 Testar"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {catalogLocal.length === 0 && (
                      <tr><td className="td td--center" colSpan={10}>Nenhuma API cadastrada.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Detalhes de Erro */}
      {errorModal.open && errorModal.entry && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setErrorModal({ open: false, entry: null })}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title"><strong>{errorModal.entry.title}</strong></div>
              <button className="modal__close" onClick={() => setErrorModal({ open: false, entry: null })} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div className="tableCard" style={{ padding: 12 }}>
                <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{errorModal.entry.details}</div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
                <button className="btn" onClick={() => setErrorModal({ open: false, entry: null })}>Fechar</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Tratativa (comentários) */}
      {tratativaModal.open && tratativaModal.group && (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setTratativaModal((s) => ({ ...s, open: false }))}
        >
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title">
                <strong>Tratativa</strong>
                <div className="muted" style={{ marginTop: 4 }}>
                  {tratativaModal.group.name || "(sem nome)"} · {tratativaModal.group.itemReference || "—"}
                </div>
              </div>
              <button
                className="modal__close"
                onClick={() => setTratativaModal((s) => ({ ...s, open: false }))}
                aria-label="Fechar"
              >
                ✕
              </button>
            </div>

            {/* <div className="modal__body" style={{ display: "grid", gap: 12 }}> */}
            <div className="modal__body modal__body--scroll">

              {tratativaModal.error && <div className="error">{tratativaModal.error}</div>}

              {/* Formulário de edição/criação */}
              <div className="tableCard tratativa-form" style={{ padding: 12, display: "grid", gap: 8 }}>
                <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 8 }}>
                  <label className="muted" style={{ alignSelf: "center" }}>Status</label>
                  <select
                    className="input select"
                    value={tratativaModal.status}
                    onChange={(e) => setTratativaModal((s) => ({ ...s, status: e.target.value }))}
                  >
                    {["Não tratado", "Em andamento", "Concluído", "Oportunidade"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>

                  <label className="muted" style={{ alignSelf: "start" }}>Comentário</label>
                  <textarea
                    className="input"
                    rows={3}
                    placeholder="Escreva um comentário…"
                    value={tratativaModal.text}
                    onChange={(e) => setTratativaModal((s) => ({ ...s, text: e.target.value }))}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  {/* TESTE */}
                  <button
                    className="btn btn--secondary"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        const grp = tratativaModal.group!;
                        const comments = await apiListCommentsByReference(grp, grp.itemReference);
                        exportGroupToCSV(grp, comments, occurrenceMsWithOffset);
                      } catch (err) {
                        alert("Erro ao exportar CSV: " + (err as Error).message);
                      }
                    }}
                  >
                    Exportar
                  </button>


                  <button
                    className="btn btn--secondary"
                    onClick={async () => {
                      const grp = tratativaModal.group!;
                      // injeta o status atual na instância do grupo (só para o cabeçalho do PDF)
                      (grp as any)._statusShown = statusShownForGroup(grp);
                      const comments = await apiListCommentsByReference(grp, grp.itemReference);
                      printGroupReport(grp, comments, occurrenceMsWithOffset);
                    }}
                  >
                    Imprimir
                  </button>

                  {/* TESTE */}
                  
                  <button
                    className="btn"
                    onClick={() => setTratativaModal((s) => ({ ...s, open: false }))}
                    disabled={tratativaModal.busy}
                  >
                    Cancelar
                  </button>
                  <button
                    className="btn btn--primary"
                    onClick={onSaveTratativa}
                    disabled={tratativaModal.busy || (!tratativaModal.text && !tratativaModal.editingId)}
                    title={tratativaModal.editingId ? "Salvar edição" : "Adicionar comentário"}
                  >
                    {tratativaModal.busy ? "Salvando…" : (tratativaModal.editingId ? "💾 Salvar" : "➕ Adicionar")}
                  </button>
                </div>
              </div>

              {/* Lista de comentários */}
              <div className="tableCard comments-scroll">
                <table className="table">
                  <thead>
                    <tr className="thead-title">
                      <th className="th"><span className="th__inner"><span>Data</span></span></th>
                      <th className="th"><span className="th__inner"><span>Status</span></span></th>
                      <th className="th"><span className="th__inner"><span>Texto</span></span></th>
                      <th className="th"><span className="th__inner"><span>Ações</span></span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tratativaModal.comments.map((c) => (
                      <tr key={c.id}>
                        {/* Comentários: dd/mm/yy hh:mm:ss */}
                        <td className="td td--nowrap">{msToDMYTime(isoToMs(c.created_at))}</td>
                        <td className="td">{c.status ?? "—"}</td>
                        <td className="td">{c.text}</td>
                        <td className="td td--nowrap">
                          <button
                            className="btn btn--ghost"
                            onClick={() => onEditComment(c)}
                            disabled={tratativaModal.busy}
                          >
                            ✏️ Editar
                          </button>{" "}
                          <button
                            className="btn btn--ghost"
                            onClick={() => onDeleteComment(c)}
                            disabled={tratativaModal.busy}
                          >
                            🗑️ Excluir
                          </button>
                        </td>
                      </tr>
                    ))}
                    {tratativaModal.comments.length === 0 && (
                      <tr>
                        <td className="td td--center" colSpan={4}>Sem comentários.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}