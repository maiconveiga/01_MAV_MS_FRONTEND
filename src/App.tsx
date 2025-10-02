import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import "./App.css";
import type { CatalogApi, Session, AlarmItem } from "./types";
import { fetchCatalog, createApi, updateApi, deleteApi, getApiId } from "./services/manager";
import { loginAndGetToken, collectAlarmsBatch } from "./services/collector";

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
  _latest: AlarmItem | null; // item mais recente do grupo
};

/* --------- Utils --------- */
const msToDMY = (ms?: number) => {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const isoToMs = (s?: string) => (s ? (Number.isFinite(Date.parse(s)) ? Date.parse(s) : 0) : 0);
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
const fmtMMSS = (s: number) => `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;
const summarize = (sel: string[], total: number) => (sel.length === 0 || sel.length === total ? "(Todos)" : `${sel.length} selecionado(s)`);

// Normalização: regras que consideram "normalizado"
const isNormalized = (g: GroupRow) => {
  const L = (g._latest as any) ?? {};
  the:
  // ^— evita erro de “unused label” em bundlers; é só um marcador visual
  // (sem efeito em runtime)
  void 0;
  const type = String(L?.type ?? g.type ?? "").toLowerCase();
  const val = String(L?.triggerValue_value ?? L?.triggerValue?.value ?? g.value ?? "").toLowerCase();
  return val === "online" || type === "normal" || type === "online";
};

/* ======== Componente ======== */
export default function App() {
  // data principal
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<AlarmItem[]>([]);

  // catálogo (para o modal de APIs e detecção de versão)
  const [catalogLocal, setCatalogLocal] = useState<CatalogApi[]>([]);

  // map auxiliares: BaseUrl → nome/offset
  const [serverNameByBase, setServerNameByBase] = useState<Record<string, string>>({});
  const [offsetByBase, setOffsetByBase] = useState<Record<string, number>>({});

  // ordenação e filtros
  const [sortKey, setSortKey] = useState<SortKey>("inserido");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Filtros multi (via modal)
  const [fServidores, setFServidores] = useState<string[]>([]);
  const [fTipos, setFTipos] = useState<string[]>([]);
  const [fTratativas, setFTratativas] = useState<string[]>([]);

  // filtro Tratativa
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

  // modal de grupo
  const [modalGroup, setModalGroup] = useState<GroupRow | null>(null);

  // modal CRUD de APIs
  const [apisOpen, setApisOpen] = useState(false);
  const [apisError, setApisError] = useState<string | null>(null);
  const [apisBusy, setApisBusy] = useState(false);

  // aviso/resultado de teste (no modal de APIs)
  const [apisNotice, setApisNotice] = useState<string | null>(null);
  const [testBusyById, setTestBusyById] = useState<Record<string, boolean>>({});

  type ApiForm = {
    Servidor: string;
    IP: string;
    Usuario: string;
    offset: number;
    Versao: string;
    QuantidadeAlarmes: number;
    Senha: string;
  };
  const emptyForm: ApiForm = { Servidor: "", IP: "", Usuario: "", offset: 0, Versao: "V3", QuantidadeAlarmes: 1, Senha: "" };
  const [form, setForm] = useState<ApiForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);

  // auto-reload
  const REFRESH_MS = 60_000;
  const [nextTs, setNextTs] = useState<number>(() => Date.now() + REFRESH_MS);
  const [leftSec, setLeftSec] = useState<number>(Math.ceil((nextTs - Date.now()) / 1000));
  const manualReload = () => {
    setNextTs(Date.now() + REFRESH_MS);
    void reload();
  };

  // ====== ERROS por API (botões + modal) ======
  type ErrorEntry = {
    id: string;
    title: string;
    details: string;
    port?: string | number;
  };
  const [apiErrors, setApiErrors] = useState<ErrorEntry[]>([]);
  const [errorModal, setErrorModal] = useState<{ open: boolean; entry: ErrorEntry | null }>({ open: false, entry: null });

  const addApiError = useCallback((e: ErrorEntry) => {
    setApiErrors(prev => (prev.some(x => x.id === e.id) ? prev : [...prev, e]));
  }, []);
  const clearApiErrors = useCallback(() => setApiErrors([]), []);

  // helpers tempo
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

  // carregar tudo — parcial + erros
  const reload = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      clearApiErrors();

      const catalog = await fetchCatalog();
      setCatalogLocal(catalog);

      const nameBy: Record<string, string> = {};
      const offBy: Record<string, number> = {};
      for (const a of catalog) {
        nameBy[a.BaseUrl] = a.Servidor;
        offBy[a.BaseUrl] = a.offset ?? 0;
      }
      setServerNameByBase(nameBy);
      setOffsetByBase(offBy);

      const aggregated: AlarmItem[] = [];

      for (const a of catalog) {
        const baseUrl = a.BaseUrl;
        let port = "";
        try {
          const u = new URL(baseUrl);
          port = u.port || (u.protocol === "https:" ? "443" : "80");
        } catch {
          addApiError({
            id: `${baseUrl}::url`,
            title: "Metasys IP inoperante",
            details: `BaseUrl inválida no catálogo: ${baseUrl}. Verifique o IP/porta/versão.`
          });
          continue;
        }

        // 1) Login
        let token: string | null = null;
        try {
          token = await loginAndGetToken({
            base_url: baseUrl,
            usuario: a.Usuario,
            senha: a.Senha,
            verify_ssl: false
          });
        } catch (e: any) {
          const msg = (e?.message ?? String(e)).toLowerCase();
          if (msg.includes("failed to fetch") || msg.includes("network") || msg.includes("connect") || msg.includes("timeout")) {
            addApiError({
              id: `${baseUrl}::collector-offline`,
              title: `API data colletor (${port}) offline`,
              details: `Não foi possível conectar ao Data Collector em ${baseUrl} (porta ${port}). Detalhes: ${e?.message ?? String(e)}`,
              port
            });
          } else {
            addApiError({
              id: `${baseUrl}::login`,
              title: "Metasys IP inoperante",
              details: `Falha no login para ${baseUrl}. Verifique IP/credenciais. Detalhes: ${e?.message ?? String(e)}`
            });
          }
          continue;
        }

        // 2) Coleta
        try {
          const session: Session = {
            base_url: baseUrl,
            token: token!,
            offset: a.offset ?? 0,
            servidor: a.Servidor,
            pageSize: Math.max(1, a.QuantidadeAlarmes || 1),
            page: 1,
            verify_ssl: false
          };
          const result = await collectAlarmsBatch([session]);
          aggregated.push(...result);
        } catch (e: any) {
          addApiError({
            id: `${baseUrl}::collect`,
            title: "Metasys IP inoperante",
            details: `Falha ao coletar alarmes de ${baseUrl}. Detalhes: ${e?.message ?? String(e)}`
          });
        }
      }

      setItems(aggregated);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
      setNextTs(Date.now() + REFRESH_MS);
    }
  }, [REFRESH_MS, addApiError, clearApiErrors]);

  useEffect(() => { void reload(); }, [reload]);

  // countdown + auto-disparo
  useEffect(() => {
    const id = setInterval(() => {
      const msLeft = Math.max(0, nextTs - Date.now());
      const s = Math.ceil(msLeft / 1000);
      setLeftSec(s);
      if (msLeft <= 0 && !loading) {
        void reload();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [nextTs, loading, reload]);

  // selects base de opções
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

  const uniqTratativas = useMemo(() => ["Não tratado", "Em andamento", "Concluído", "Oportunidade"], []);

  // filtros primários
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
      if (valorTxt && !( (`${v} ${u}`).trim().toLowerCase().includes(valorTxt) )) return false;
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
    items, fServidores, fTipos, fNome, fItemRef, fMensagem, fValorTxt,
    fPriorMin, fPriorMax, fAck, fDesc, fInsDe, fInsAte, serverNameByBase, insertedMs
  ]);

  // agrupamento
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

  /* ====== TRATATIVA: estado automático + comentários (por reference) ====== */
  type Comment = { id: string; reference: string; text: string; status?: string | null; created_at: string };

  const [autoTratativa, setAutoTratativa] = useState<Record<string, string>>({});
  const [lastStatusByRef, setLastStatusByRef] = useState<Record<string, string>>({});
  const [lastTextByRef, setLastTextByRef] = useState<Record<string, string>>({});
  const [lastStatusAtByRef, setLastStatusAtByRef] = useState<Record<string, number>>({});

  const fetchedAtRef = useRef<Record<string, number>>({});
  const STATUS_TTL_MS = 60_000;

  // ====== Backend de comentários (por reference)
  const COMMENTS_HOST = "10.2.1.133";
  const getVersionForBase = (baseUrl: string): string => {
    const hit = catalogLocal.find(c => c.BaseUrl === baseUrl)?.Versao;
    if (hit) return String(hit);
    const m = baseUrl.match(/\/api\/V?(\d+)/i);
    return m ? `V${m[1]}` : "V3";
  };
  const portFromVersion = (versao: string) => 5000 + (Number(versao.replace(/[^\d]/g, "")) || 3);
  const commentsOriginForGroup = (g: GroupRow) => `http://${COMMENTS_HOST}:${portFromVersion(getVersionForBase(g.base))}`;
  const referenceForGroup = (g: GroupRow) => g.itemReference;

  type CommentIn = { reference: string; text: string; status: string };

  async function apiListCommentsByReference(g: GroupRow, reference: string) {
    const origin = commentsOriginForGroup(g);
    const url = `${origin}/comments?reference=${encodeURIComponent(reference)}&pageSize=1000`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`list ${r.status}`);
    return (await r.json()) as Comment[];
  }
  async function apiCreateComment(g: GroupRow, body: CommentIn) {
    const origin = commentsOriginForGroup(g);
    const r = await fetch(`${origin}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: body.reference, text: body.text, status: body.status }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`create ${r.status}: ${t || "sem corpo"}`);
    return JSON.parse(t) as Comment;
  }
  async function apiUpdateComment(g: GroupRow, id: string, patch: Partial<Pick<Comment, "text" | "status">>) {
    const origin = commentsOriginForGroup(g);
    const r = await fetch(`${origin}/comments/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`update ${r.status}: ${t || "sem corpo"}`);
    return JSON.parse(t) as Comment;
  }
  async function apiDeleteComment(g: GroupRow, id: string) {
    const origin = commentsOriginForGroup(g);
    const r = await fetch(`${origin}/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`delete ${r.status}`);
    return true;
  }

  // Carrega status/texto/horário do banco para os grupos exibidos
  useEffect(() => {
    let cancelled = false;
    const pairs: Array<{ g: GroupRow; ref: string }> = [];
    const now = Date.now();
    for (const g of groupedRowsRaw) {
      const ref = referenceForGroup(g);
      if (!ref) continue;
      const lastFetched = fetchedAtRef.current[ref] ?? 0;
      if (now - lastFetched > STATUS_TTL_MS) {
        pairs.push({ g, ref });
      }
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

        setLastStatusByRef(prev => ({ ...prev, [ref]: status }));
        setLastTextByRef(prev => ({ ...prev, [ref]: lastText }));
        setLastStatusAtByRef(prev => ({ ...prev, [ref]: lastAt }));

        fetchedAtRef.current[ref] = Date.now();
      } catch {
        fetchedAtRef.current[ref] = Date.now();
      } finally {
        void runNext();
      }
    };

    for (let k = 0; k < Math.min(CONCURRENCY, pairs.length); k++) void runNext();
    return () => { cancelled = true; };
  }, [groupedRowsRaw]);

  // Regras automáticas (UI-only)
  useEffect(() => {
    let cancelled = false;

    const applyRules = async () => {
      for (const g of groupedRowsRaw) {
        if (cancelled) return;
        const ref = referenceForGroup(g);
        if (!ref) continue;

        const normalized = isNormalized(g);
        const currentPersisted = (lastStatusByRef[ref] ?? "").toLowerCase();
        const currentAuto = (autoTratativa[g.key] ?? "").toLowerCase();
        const lastAt = lastStatusAtByRef[ref] ?? 0;
        const latestAlarm = g.latestInsertedMs || 0;
        const hasNewAlarm = latestAlarm > lastAt;

        if (normalized) {
          if (currentAuto !== "concluído" && currentAuto !== "concluido") {
            setAutoTratativa(prev => ({ ...prev, [g.key]: "Concluído" }));
          }
          continue;
        }

        const wasClosedOrWorking =
          ["concluído", "concluido", "em andamento", "oportunidade"].includes(currentPersisted) ||
          ["concluído", "concluido", "em andamento", "oportunidade"].includes(currentAuto);

        if (hasNewAlarm && wasClosedOrWorking) {
          if (currentAuto !== "não tratado") {
            setAutoTratativa(prev => ({ ...prev, [g.key]: "Não tratado" }));
          }
        }
      }
    };

    void applyRules();
    return () => { cancelled = true; };
  }, [groupedRowsRaw, lastStatusByRef, lastStatusAtByRef, autoTratativa]);

  // sino
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

  // Ordenação
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

  const statusShownForGroup = (g: GroupRow) => {
    const ref = g.itemReference ?? "";
    if (isNormalized(g)) return "Concluído";
    return lastStatusByRef[ref] ?? autoTratativa[g.key] ?? "Não tratado";
  };

  const groupedSorted = useMemo(() => {
    if (!fTratativas.length) return groupedSortedBase;
    return groupedSortedBase.filter(g => fTratativas.includes(statusShownForGroup(g)));
  }, [groupedSortedBase, fTratativas]);

  const setSort = (k: SortKey, d: "asc" | "desc") => {
    setSortKey(k);
    setSortDir(d);
  };

  const total = items.length, totalShown = groupedSorted.length;

  const clearFilters = () => {
    setFServidores([]);
    setFTipos([]);
    setFTratativas([]);
    setFNome("");
    setFItemRef("");
    setFMensagem("");
    setFValorTxt("");
    setFPriorMin("");
    setFPriorMax("");
    setFAck("");
    setFDesc("");
    setFInsDe("");
    setFInsAte("");
  };

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

  /* --------- Modais de filtros (Servidor / Tipo / Tratativa) --------- */
  const [serverModalOpen, setServerModalOpen] = useState(false);
  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [tratModalOpen, setTratModalOpen] = useState(false);

  const [tempServidores, setTempServidores] = useState<string[]>([]);
  const [tempTipos, setTempTipos] = useState<string[]>([]);
  const [tempTrat, setTempTrat] = useState<string[]>([]);

  const [serverSearch, setServerSearch] = useState("");
  const [typeSearch, setTypeSearch] = useState("");
  const [tratSearch, setTratSearch] = useState("");

  const filteredServerOpts = useMemo(
    () => uniqServidores.filter(s => s.toLowerCase().includes(serverSearch.toLowerCase())),
    [uniqServidores, serverSearch]
  );
  const filteredTypeOpts = useMemo(
    () => uniqTipos.filter(s => s.toLowerCase().includes(typeSearch.toLowerCase())),
    [uniqTipos, typeSearch]
  );
  const filteredTratOpts = useMemo(
    () => uniqTratativas.filter(s => s.toLowerCase().includes(tratSearch.toLowerCase())),
    [uniqTratativas, tratSearch]
  );

  const toggleTemp = (arr: string[], setArr: (v: string[]) => void, v: string) =>
    setArr(arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);

  /* --------- CRUD APIs + TESTAR --------- */
  const openApisModal = async () => {
    setApisError(null);
    setApisNotice(null);
    setForm(emptyForm);
    setEditingId(null);
    try {
      setApisBusy(true);
      setCatalogLocal(await fetchCatalog());
      setApisOpen(true);
    } catch (e: any) {
      setApisError(e?.message ?? String(e));
    } finally {
      setApisBusy(false);
    }
  };

  const startCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const startEdit = (api: CatalogApi) => {
    const editing = getApiId(api);
    setEditingId(editing);
    setForm({
      Servidor: api.Servidor ?? "",
      IP: api.IP ?? "",
      Usuario: api.Usuario ?? "",
      offset: Number(api.offset ?? 0),
      Versao: String(api.Versao ?? "V3"),
      QuantidadeAlarmes: Number(api.QuantidadeAlarmes ?? 1),
      Senha: api.Senha ?? "",
    });
  };

  const saveApi = async () => {
    try {
      setApisBusy(true);
      setApisError(null);
      setApisNotice(null);
      const clamp = (n: number) => Math.max(-12, Math.min(12, n));
      const payload = {
        Servidor: form.Servidor.trim(),
        IP: form.IP.trim(),
        Usuario: form.Usuario.trim(),
        offset: clamp(Number(form.offset ?? 0)),
        Versao: (form.Versao || "V3").toUpperCase(),
        QuantidadeAlarmes: Math.max(1, Number(form.QuantidadeAlarmes ?? 1)),
        Senha: form.Senha ?? "",
      };
      if (editingId) await updateApi(editingId, payload);
      else await createApi(payload);
      const list = await fetchCatalog();
      setCatalogLocal(list);
      startCreate();
      setApisNotice("Registro salvo.");
      setTimeout(() => setApisNotice(null), 2500);
      await reload();
    } catch (e: any) {
      setApisError(e?.message ?? String(e));
    } finally {
      setApisBusy(false);
    }
  };

  const removeApi = async (id: string | null) => {
    if (!id) return;
    if (!confirm("Excluir esta API do catálogo?")) return;
    try {
      setApisBusy(true);
      setApisError(null);
      setApisNotice(null);
      await deleteApi(id);
      setCatalogLocal(await fetchCatalog());
      setApisNotice("API removida.");
      setTimeout(() => setApisNotice(null), 2500);
      await reload();
    } catch (e: any) {
      setApisError(e?.message ?? String(e));
    } finally {
      setApisBusy(false);
    }
  };

  const testApi = async (api: CatalogApi) => {
    const id = getApiId(api) || `${api.Servidor}-${api.IP}-${api.Versao}`;
    setTestBusyById(prev => ({ ...prev, [id]: true }));
    setApisError(null);
    setApisNotice(null);
    try {
      const token = await loginAndGetToken({
        base_url: api.BaseUrl,
        usuario: api.Usuario,
        senha: api.Senha,
        verify_ssl: false
      });
      if (token) {
        setApisNotice(`API online (${api.BaseUrl})`);
        setTimeout(() => setApisNotice(null), 2500);
      } else {
        setApisError(`Sem token ao testar ${api.BaseUrl}.`);
      }
    } catch (e: any) {
      setApisError(`Falha no teste de ${api.BaseUrl}: ${e?.message ?? String(e)}`);
    } finally {
      setTestBusyById(prev => ({ ...prev, [id]: false }));
    }
  };

  /* --------- Tratativa: modal e ações --------- */
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
    const reference = g.itemReference;
    if (!reference) return;
    setTratativaModal(s => ({ ...s, open: true, group: g, busy: true, error: null, comments: [], text: "", editingId: null, status: "Não tratado" }));
    try {
      const comments = await apiListCommentsByReference(g, reference);

      if (comments[0]?.status) setLastStatusByRef(prev => ({ ...prev, [reference]: String(comments[0].status) }));
      if (comments[0]?.text) setLastTextByRef(prev => ({ ...prev, [reference]: String(comments[0].text) }));
      if (comments[0]?.created_at) setLastStatusAtByRef(prev => ({ ...prev, [reference]: isoToMs(comments[0].created_at) || 0 }));

      setTratativaModal(s => ({
        ...s,
        open: true,
        group: g,
        comments,
        busy: false,
        error: null,
        text: "",
        status: isNormalized(g) ? "Concluído" : (comments[0]?.status ?? (autoTratativa[g.key] ?? "Não tratado")),
        editingId: null
      }));
    } catch (e: any) {
      setTratativaModal(s => ({ ...s, busy: false, error: e?.message ?? String(e) }));
    }
  };

  const onSaveTratativa = async () => {
    const m = tratativaModal;
    if (!m.group) return;
    const reference = m.group.itemReference;
    if (!reference) {
      setTratativaModal(s => ({ ...s, error: "Este grupo não possui itemReference para usar como reference." }));
      return;
    }
    try {
      setTratativaModal(s => ({ ...s, busy: true, error: null }));

      if (m.editingId) {
        const up = await apiUpdateComment(m.group, m.editingId, { text: m.text, status: m.status });
        setLastTextByRef(prev => ({ ...prev, [reference]: up.text }));
        if (up.status) setLastStatusByRef(prev => ({ ...prev, [reference]: String(up.status) }));
      } else {
        const created = await apiCreateComment(m.group, { reference, text: m.text || "(sem texto)", status: m.status });
        setLastTextByRef(prev => ({ ...prev, [reference]: created.text }));
        if (created.status) setLastStatusByRef(prev => ({ ...prev, [reference]: String(created.status) }));
      }

      const comments = await apiListCommentsByReference(m.group, reference);
      setTratativaModal(s => ({ ...s, comments, text: "", editingId: null, busy: false, status: comments[0]?.status ?? m.status }));

      if (comments[0]?.status) setLastStatusByRef(prev => ({ ...prev, [reference]: String(comments[0].status) }));
      if (comments[0]?.created_at) setLastStatusAtByRef(prev => ({ ...prev, [reference]: isoToMs(comments[0].created_at) || 0 }));

      setAutoTratativa(prev => ({ ...prev, [m.group!.key]: comments[0]?.status ?? m.status }));
    } catch (e: any) {
      setTratativaModal(s => ({ ...s, busy: false, error: e?.message ?? String(e) }));
    }
  };

  const onEditComment = (c: Comment) => {
    setTratativaModal(s => ({ ...s, editingId: c.id, text: c.text, status: c.status ?? "Não tratado" }));
  };

  const onDeleteComment = async (c: Comment) => {
    const m = tratativaModal;
    if (!m.group) return;
    if (!confirm("Excluir este comentário?")) return;
    try {
      setTratativaModal(s => ({ ...s, busy: true, error: null }));
      await apiDeleteComment(m.group, c.id);
      const reference = m.group.itemReference;
      const comments = reference ? await apiListCommentsByReference(m.group, reference) : [];
      setTratativaModal(s => ({ ...s, comments, busy: false, editingId: null, text: "" }));
      if (reference) {
        const newStatus = comments[0]?.status ?? (isNormalized(m.group!) ? "Concluído" : (autoTratativa[m.group!.key] ?? "Não tratado"));
        setLastStatusByRef(prev => ({ ...prev, [reference]: newStatus }));
        setLastTextByRef(prev => ({ ...prev, [reference]: comments[0]?.text ?? "" }));
        setLastStatusAtByRef(prev => ({ ...prev, [reference]: isoToMs(comments[0]?.created_at) || 0 }));
      }
    } catch (e: any) {
      setTratativaModal(s => ({ ...s, busy: false, error: e?.message ?? String(e) }));
    }
  };

  // estilo do botão por status
  const statusBtnClass = (status: string) => {
    const s = (status || "").toLowerCase();
    if (s === "em andamento") return "btn--status st-progress";
    if (s === "concluído" || s === "concluido") return "btn--status st-done";
    if (s === "oportunidade") return "btn--status st-opportunity";
    return "btn--status st-not";
  };

  /* --------- Render --------- */
  return (
    <div className="page">
      {/* AppBar */}
      <div className="appbar">
        <div className="appbar__title">METASYS ALARM VIEWER</div>
        <div className="appbar__actions" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={manualReload}
            disabled={loading}
            className="btn btn--primary"
            title={`Recarregar agora • próximo automático em ${fmtMMSS(leftSec)}`}
          >
            🔄 Recarregar ({fmtMMSS(leftSec)})
          </button>
          <button onClick={openApisModal} className="btn btn--secondary" title="Gerenciar APIs">🧰 API's</button>
          <button onClick={clearFilters} className="btn" title="Limpar filtros">🧹 Limpar filtros</button>

          {/* Botões de erro */}
          {apiErrors.length === 0 ? (
            <button className="btn" disabled title="Sem erros detectados">✅ Online</button>
          ) : (
            apiErrors.map((e) => (
              <button
                key={e.id}
                className="btn btn--danger"
                onClick={() => setErrorModal({ open: true, entry: e })}
                title="Clique para ver detalhes do erro"
              >
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

      {/* Tabela principal */}
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
                {/* Servidor: botão -> modal */}
                <th className="th">
                  <button
                    type="button"
                    className="input"
                    onClick={() => {
                      setTempServidores([...fServidores]);
                      setServerSearch("");
                      setServerModalOpen(true);
                    }}
                    title="Clique para filtrar por Servidor"
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                  >
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Servidor:</span>
                    <span>{summarize(fServidores, uniqServidores.length)}</span>
                  </button>
                </th>
                <th className="th"><input value={fNome} onChange={e => setFNome(e.target.value)} placeholder="contém…" className="input" /></th>
                <th className="th"><input value={fItemRef} onChange={e => setFItemRef(e.target.value)} placeholder="contém…" className="input" /></th>
                <th className="th"><input value={fMensagem} onChange={e => setFMensagem(e.target.value)} placeholder="contém…" className="input" /></th>
                <th className="th"><input value={fValorTxt} onChange={e => setFValorTxt(e.target.value)} placeholder="ex.: 22.5 °C" className="input" /></th>
                <th className="th">
                  <div className="grid2">
                    <input value={fPriorMin} onChange={e => setFPriorMin(e.target.value)} placeholder="min" className="input" inputMode="numeric" />
                    <input value={fPriorMax} onChange={e => setFPriorMax(e.target.value)} placeholder="max" className="input" inputMode="numeric" />
                  </div>
                </th>
                {/* Tipo: botão -> modal */}
                <th className="th">
                  <button
                    type="button"
                    className="input"
                    onClick={() => {
                      setTempTipos([...fTipos]);
                      setTypeSearch("");
                      setTypeModalOpen(true);
                    }}
                    title="Clique para filtrar por Tipo"
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                  >
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Tipo:</span>
                    <span>{summarize(fTipos, uniqTipos.length)}</span>
                  </button>
                </th>
                <th className="th">
                  <select value={fAck} onChange={e => setFAck(e.target.value)} className="input select">
                    <option value="">(Todos)</option><option value="sim">Sim</option><option value="nao">Não</option>
                  </select>
                </th>
                <th className="th">
                  <select value={fDesc} onChange={e => setFDesc(e.target.value)} className="input select">
                    <option value="">(Todos)</option><option value="sim">Sim</option><option value="nao">Não</option>
                  </select>
                </th>
                <th className="th">
                  <div className="grid2">
                    <input type="date" value={fInsDe} onChange={e => setFInsDe(e.target.value)} className="input" />
                    <input type="date" value={fInsAte} onChange={e => setFInsAte(e.target.value)} className="input" />
                  </div>
                </th>
                {/* Tratativa: botão -> modal */}
                <th className="th">
                  <button
                    type="button"
                    className="input"
                    onClick={() => {
                      setTempTrat([...fTratativas]);
                      setTratSearch("");
                      setTratModalOpen(true);
                    }}
                    title="Clique para filtrar por Tratativa"
                    style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                  >
                    <span style={{ fontWeight: 600, color: "var(--muted)" }}>Tratativa:</span>
                    <span>{summarize(fTratativas, uniqTratativas.length)}</span>
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
                    <td className="td td--servidor">
                      <span title="status"><Bell color={bell} /></span>
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer" className="link" title={g.servidorName}>
                          {g.servidorName || "—"}
                        </a>
                      ) : (g.servidorName || "—")}
                    </td>
                    <td className="td">
                      <strong title={g.name || ""}>{g.name || g.itemReference || "(sem nome)"}</strong>{" "}
                      {g.items.length > 1 && (
                        <button
                          className="btn btn--ghost badge"
                          title={`Ver ${g.items.length} alarmes do grupo`}
                          onClick={() => setModalGroup(g)}
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
                    <td className="td td--nowrap">{msToDMY(g.latestInsertedMs)}</td>
                    <td className="td">
                      <button
                        className={`btn ${statusBtnClass(status)}`}
                        title="Ver/editar tratativa"
                        onClick={() => openTratativaModal(g)}
                      >
                        {status}
                      </button>
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
                        const occDisp = msToDMY(occurrenceMsWithOffset(it));
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

      {/* Modal: Filtro de Servidor */}
      {serverModalOpen && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setServerModalOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title"><strong>Filtrar por Servidor</strong></div>
              <button className="modal__close" onClick={() => setServerModalOpen(false)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input className="input" placeholder="Buscar servidor..." value={serverSearch} onChange={e => setServerSearch(e.target.value)} />
                <button className="btn btn--ghost" onClick={() => setTempServidores([...uniqServidores])}>Selecionar todos</button>
                <button className="btn btn--ghost" onClick={() => setTempServidores([])}>Limpar</button>
              </div>
              <div className="tableCard" style={{ padding: 8 }}>
                <div style={{ maxHeight: 320, overflow: "auto", display: "grid", gap: 6 }}>
                  {filteredServerOpts.map(opt => (
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

      {/* Modal: Filtro de Tipo */}
      {typeModalOpen && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setTypeModalOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title"><strong>Filtrar por Tipo</strong></div>
              <button className="modal__close" onClick={() => setTypeModalOpen(false)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input className="input" placeholder="Buscar tipo..." value={typeSearch} onChange={e => setTypeSearch(e.target.value)} />
                <button className="btn btn--ghost" onClick={() => setTempTipos([...uniqTipos])}>Selecionar todos</button>
                <button className="btn btn--ghost" onClick={() => setTempTipos([])}>Limpar</button>
              </div>
              <div className="tableCard" style={{ padding: 8 }}>
                <div style={{ maxHeight: 320, overflow: "auto", display: "grid", gap: 6 }}>
                  {filteredTypeOpts.map(opt => (
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

      {/* Modal: Filtro de Tratativa */}
      {tratModalOpen && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setTratModalOpen(false)}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title"><strong>Filtrar por Tratativa</strong></div>
              <button className="modal__close" onClick={() => setTratModalOpen(false)} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <input className="input" placeholder="Buscar status..." value={tratSearch} onChange={e => setTratSearch(e.target.value)} />
                <button className="btn btn--ghost" onClick={() => setTempTrat([...uniqTratativas])}>Selecionar todos</button>
                <button className="btn btn--ghost" onClick={() => setTempTrat([])}>Limpar</button>
              </div>
              <div className="tableCard" style={{ padding: 8 }}>
                <div style={{ maxHeight: 320, overflow: "auto", display: "grid", gap: 6 }}>
                  {filteredTratOpts.map(opt => (
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

      {/* Modal: Gerenciar APIs (Senha mascarada) */}
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

              {/* Form */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 12 }}>
                <input className="input" placeholder="Servidor" value={form.Servidor} onChange={e => setForm(f => ({ ...f, Servidor: e.target.value }))} />
                <input className="input" placeholder="IP (ex.: 10.2.1.133)" value={form.IP} onChange={e => setForm(f => ({ ...f, IP: e.target.value }))} inputMode="numeric" />
                <select className="input select" value={form.Versao} onChange={e => setForm(f => ({ ...f, Versao: e.target.value }))}>
                  {["V1","V2","V3","V4","V5","V6"].map(v => <option key={v} value={v}>{v}</option>)}
                </select>
                <input className="input" placeholder="Qtd Alarmes" inputMode="numeric" value={String(form.QuantidadeAlarmes)} onChange={e => setForm(f => ({ ...f, QuantidadeAlarmes: Number(e.target.value || 1) }))} />
                <input className="input" placeholder="Usuário" value={form.Usuario} onChange={e => setForm(f => ({ ...f, Usuario: e.target.value }))} />
                <input className="input" placeholder="Senha" type="password" value={form.Senha} onChange={e => setForm(f => ({ ...f, Senha: e.target.value }))} />
                {/* Offset como SELECT -12..12 */}
                <div style={{ gridColumn: "span 6 / auto" }}>
                  <label className="muted" style={{ display: "block", marginBottom: 4 }}>Offset (h)</label>
                  <select
                    className="input select"
                    value={String(form.offset)}
                    onChange={e => setForm(f => ({ ...f, offset: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 25 }, (_, i) => i - 12).map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
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

              {/* Lista (Senha mascarada) + Testar */}
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
                            <button
                              className="btn btn--secondary"
                              onClick={() => testApi(api)}
                              disabled={!!testBusyById[id] || apisBusy}
                              title="Testar conexão e login"
                            >
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

      {/* Modal: Detalhes de Erro (API/Collector) */}
      {errorModal.open && errorModal.entry && (
        <div className="modal" role="dialog" aria-modal="true" onClick={() => setErrorModal({ open: false, entry: null })}>
          <div className="modal__card" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <div className="modal__title">
                <strong>{errorModal.entry.title}</strong>
              </div>
              <button className="modal__close" onClick={() => setErrorModal({ open: false, entry: null })} aria-label="Fechar">✕</button>
            </div>
            <div className="modal__body">
              <div className="tableCard" style={{ padding: 12 }}>
                <div className="muted" style={{ whiteSpace: "pre-wrap" }}>
                  {errorModal.entry.details}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12, gap: 8 }}>
                <button className="btn" onClick={() => setErrorModal({ open: false, entry: null })}>Fechar</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
