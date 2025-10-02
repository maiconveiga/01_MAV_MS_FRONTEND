// src/types.ts
export interface CatalogApi {
  Servidor: string;
  BaseUrl: string;          // ex.: http://host/api/v3
  QuantidadeAlarmes?: number;
  Usuario: string;
  Senha: string;
  offset?: number;          // em horas (pode ser 0)
}

export interface Session {
  base_url: string;
  token: string;
  offset: number;
  servidor: string;
  pageSize: number;
  page?: number;
  verify_ssl?: boolean;
}

// Payload do vendor (pass-through)
export interface AlarmItem {
  id: string;
  itemReference?: string;
  name?: string;
  message?: string;
  isAckRequired?: boolean;
  type?: string;               // ex.: "alarmValueEnumSet.avAlarm"
  priority?: number;
  creationTime?: string;       // ISO: "2000-01-01T12:00:00Z"
  isAcknowledged?: boolean;
  isDiscarded?: boolean;
  category?: string;
  objectUrl?: string;
  annotationsUrl?: string;
  self?: string;
  triggerValue?: {
    value?: unknown;           // pode vir com aspas
    units?: string;
  };
}

// Item enriquecido apenas no cliente (não enviado ao backend)
export interface AlarmItemUI extends AlarmItem {
  __source_base_url?: string;
  __receivedAtMs: number;      // quando o item foi recebido no cliente
}
