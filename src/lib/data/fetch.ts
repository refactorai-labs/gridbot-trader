// Shared fetch utilities

export const DEFAULT_FETCH_TIMEOUT = 15000; // 15 seconds

export function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeout: number = DEFAULT_FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}
