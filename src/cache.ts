/** Fetch with Cache Storage + optional byte-level progress. */
export async function fetchCached(
  url: string,
  onProgress?: (received: number, total: number) => void,
): Promise<ArrayBuffer> {
  const store =
    typeof caches !== "undefined" ? await caches.open("phoonnx-voices") : null;
  if (store) {
    const hit = await store.match(url);
    if (hit) return hit.arrayBuffer();
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`download failed (${resp.status}): ${url}`);

  const total = Number(resp.headers.get("content-length")) || 0;

  if (resp.body && onProgress) {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received, total);
    }
    const merged = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    if (store) {
      await store.put(url, new Response(merged, { headers: resp.headers }));
    }
    return merged.buffer;
  }

  const buf = await resp.arrayBuffer();
  if (store) await store.put(url, new Response(buf));
  return buf;
}
