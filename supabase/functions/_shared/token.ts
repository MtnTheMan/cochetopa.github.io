const encoder = new TextEncoder();

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function key() {
  const secret = Deno.env.get("COURSE_MEDIA_TOKEN_SECRET");
  if (!secret || secret.length < 32) throw new Error("COURSE_MEDIA_TOKEN_SECRET is missing or too short");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signMediaToken(payload: Record<string, unknown>) {
  const encoded = b64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), encoder.encode(encoded)));
  return `${encoded}.${b64url(signature)}`;
}

export async function verifyMediaToken(token: string) {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new Error("Malformed media token");
  const valid = await crypto.subtle.verify("HMAC", await key(), decode(signature), encoder.encode(encoded));
  if (!valid) throw new Error("Invalid media token");
  const payload = JSON.parse(new TextDecoder().decode(decode(encoded)));
  if (!payload.exp || Date.now() > Number(payload.exp)) throw new Error("Expired media token");
  return payload;
}
