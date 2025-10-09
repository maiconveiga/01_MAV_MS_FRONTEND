
import type { Session, AlarmItem, AlarmItemUI } from "../types";

const COLLECTOR_HOST = import.meta.env.VITE_COLLECTOR_HOST || "localhost";
// const COLLECTOR_HOST = "10.2.1.133";

function resolveCollectorBase(apiBaseUrl: string): string {
  let version = 3;
  try {
    const u = new URL(apiBaseUrl);
    const m = u.pathname.match(/\/api\/V?(\d+)/i);
    if (m) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v)) version = v;
    }
  } catch {
    const m = apiBaseUrl.match(/\/api\/V?(\d+)/i);
    if (m) {
      const v = parseInt(m[1], 10);
      if (Number.isFinite(v)) version = v;
    }
  }
  const port = 5000 + version; 
  return `http://${COLLECTOR_HOST}:${port}`;
}

function extractToken(obj: any): string {
  if (!obj || typeof obj !== "object") return "";
  const direct =
    obj.token || obj.access_token || obj.jwt || obj.id_token || obj.sessionToken ||
    obj?.data?.token || obj?.data?.access_token || obj?.data?.jwt || obj?.Data?.Token;
  if (typeof direct === "string" && direct.length > 10) return direct;

  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === "string" && /token/i.test(k) && v.length > 10) return v;
      if (v && typeof v === "object") stack.push(v as any);
    }
  }
  return "";
}

export async function loginAndGetToken(args: {
  base_url: string;  
  usuario: string;
  senha: string;
  verify_ssl?: boolean;
}): Promise<string> {
  const collectorBase = resolveCollectorBase(args.base_url);
  const res = await fetch(`${collectorBase}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      base_url: args.base_url, 
      usuario: args.usuario,
      senha: args.senha,
      verify_ssl: !!args.verify_ssl,
    }),
  });

  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}

  if (!res.ok) {
    throw new Error(`login ${res.status}: ${text || "sem corpo"}`);
  }

  const token = extractToken(data);
  if (!token) {
    throw new Error(`não foi possível extrair token do login. Resposta: ${text || "(vazia)"}`);
  }
  return token;
}

export async function collectAlarmsBatch(
  sessions: Session[],
  signal?: AbortSignal
): Promise<AlarmItemUI[]> {
  // Agrupa por collector (v2=5002, v3=5003)
  const groups = new Map<string, Array<{
    base_url: string; token: string; pageSize: number; page: number; offset: number; verify_ssl: boolean;
  }>>();

  for (const s of sessions) {
    const collectorBase = resolveCollectorBase(s.base_url);
    const arr = groups.get(collectorBase) ?? [];
    arr.push({
      base_url: s.base_url,
      token: s.token,
      pageSize: s.pageSize,
      page: s.page ?? 1,
      offset: s.offset ?? 0,
      verify_ssl: s.verify_ssl ?? false,
    });
    groups.set(collectorBase, arr);
  }

  const results = await Promise.allSettled(
    Array.from(groups.entries()).map(async ([collectorBase, apis]) => {
      const res = await fetch(`${collectorBase}/collect/alarms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apis }),
        signal,
      });

      const text = await res.text();
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch {}

      if (!res.ok) {
        throw new Error(`collector ${collectorBase} -> ${res.status}: ${text || "sem corpo"}`);
      }
      return { collectorBase, data, rawText: text };
    })
  );

  const mergedItems: AlarmItem[] = [];
  const byApiMerged: Array<{ base_url: string; items: AlarmItem[] }> = [];
  const errors: Array<{ collectorBase: string; message: string }> = [];
  let succeeded = 0;

  for (const r of results) {
    if (r.status === "fulfilled") {
      const { data, collectorBase } = r.value;

      if ((data?.succeeded ?? 0) === 0 && Array.isArray(data?.errors) && data.errors.length > 0) {
        const first = data.errors[0];
        const msg = first?.error?.message || first?.error?.upstream_error || JSON.stringify(first?.error ?? first);
        errors.push({ collectorBase, message: msg });
        continue;
      }

      const items: AlarmItem[] = data?.items ?? [];
      const byApi: Array<{ base_url: string; items: AlarmItem[] }> =
        (data?.by_api ?? []).map((r: any) => ({ base_url: r?.base_url, items: r?.items ?? [] }));

      mergedItems.push(...items);
      byApiMerged.push(...byApi);
      succeeded += data?.succeeded ?? (items.length > 0 ? 1 : 0);
    } else {
      errors.push({ collectorBase: "(desconhecido)", message: r.reason?.message ?? String(r.reason) });
    }
  }

  if (succeeded === 0 && errors.length > 0) {
    throw new Error(`todas as coletas falharam: ${errors[0].message}`);
  }

  const originById = new Map<string, string>();
  for (const group of byApiMerged) {
    for (const it of group.items) {
      if (it?.id) originById.set(it.id, group.base_url);
    }
  }

  const now = Date.now();
  const enriched: AlarmItemUI[] = mergedItems.map(it => ({
    ...it,
    __source_base_url: it?.id ? originById.get(it.id) : undefined,
    __receivedAtMs: now,
  }));
  return enriched;
}
