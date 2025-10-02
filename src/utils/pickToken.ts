export function pickToken(login: unknown): string | null {
  if (!login || typeof login !== "object") return null;
  const obj = login as Record<string, unknown>;
  const candidates = [
    "token","access_token","accessToken","jwt","idToken","bearer",
    "Authorization","authorization"
  ];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }

  const flat = JSON.stringify(login);
  const m = flat.match(/"(?:(?:access_)?token|jwt|idToken)"\s*:\s*"([^"]+)"/i);
  return m ? m[1] : null;
}
