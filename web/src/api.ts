export class ApiError extends Error {
  constructor(message: string, public code = 'NETWORK_ERROR', public requestId?: string) { super(message); }
}
let csrf = '';
const pending = new Map<string, string>();
export const setCsrf = (value: string) => { csrf = value; };
export async function api<T = any>(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const intent = JSON.stringify({ path, method, body, extra });
  const mutation = method !== 'GET';
  if (mutation && !pending.has(intent)) pending.set(intent, crypto.randomUUID());
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(mutation ? { 'X-CSRF-Token': csrf, 'Idempotency-Key': pending.get(intent)! } : {}), ...extra,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch { throw new ApiError('Нет связи с сервером. Проверьте подключение и обновите данные.'); }
  const data = await response.json();
  // A lost response keeps the intent key so a manual retry is safe within this page.
  if (response.status < 500) pending.delete(intent);
  if (!response.ok) throw new ApiError(data.error?.message ?? 'Не удалось выполнить действие', data.error?.code, data.error?.request_id);
  return data as T;
}
