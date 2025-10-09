import type { CatalogApi } from "../types";

const MANAGER_URL = import.meta.env.VITE_MANAGER_URL || "localhost";

function unwrap<T = any>(data: any): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  if (Array.isArray(data.items)) return data.items as T[];
  return [data as T];
}

export function getApiId(api: any): string {
  return String(api?.id ?? api?.Id ?? api?._id ?? "");
}

export async function fetchCatalog(): Promise<CatalogApi[]> {
  const res = await fetch(`${MANAGER_URL}/apis`);
  if (!res.ok) throw new Error(`manager ${res.status}`);
  const data = await res.json();
  return unwrap<CatalogApi>(data);
}

export async function createApi(payload: {
  Servidor: string;
  IP: string;
  Usuario: string;
  offset: number;
  Versao: string;           
  QuantidadeAlarmes: number;
  Senha: string;
}): Promise<CatalogApi> {
  const res = await fetch(`${MANAGER_URL}/apis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`create ${res.status}: ${text || "sem corpo"}`);
  return text ? JSON.parse(text) : ({} as any);
}

export async function updateApi(
  id: string,
  payload: {
    Servidor: string;
    IP: string;
    Usuario: string;
    offset: number;
    Versao: string;
    QuantidadeAlarmes: number;
    Senha: string;
  }
): Promise<CatalogApi> {
  const res = await fetch(`${MANAGER_URL}/apis/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`update ${res.status}: ${text || "sem corpo"}`);
  return text ? JSON.parse(text) : ({} as any);
}

export async function deleteApi(id: string): Promise<void> {
  const res = await fetch(`${MANAGER_URL}/apis/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`delete ${res.status}: ${text || "sem corpo"}`);
  }
}
