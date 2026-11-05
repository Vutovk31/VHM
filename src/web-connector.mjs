/** Host web search returns bounded VI URL candidates and persists discovery evidence. */
export function createWebConnector({ invoke, persist }) {
  if (typeof invoke !== 'function' || typeof persist !== 'function') throw new Error('Web host and evidence writer are required');
  return {
    async searchWeb({ query, limit = 4, signal }) {
      if (typeof query !== 'string' || !query.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('Invalid web domain query');
      }
      signal?.throwIfAborted();
      const args = { query: 'site:vseinstrumenti.ru ' + query, limit };
      const result = await invoke('web_search', args, { signal });
      const data = result?.structuredContent;
      const ref = await persist({ method:'web_search', args, at:new Date().toISOString(), source:'WEB_DOMAIN',
        error:!!result?.isError, data });
      if (typeof ref !== 'string' || !ref.trim()) throw new Error('Web evidence reference required');
      if (result?.isError) throw Object.assign(new Error('Web provider error'),{code:data?.code??'upstream_unavailable'});
      if (!Array.isArray(data?.products)) throw new Error('Invalid web candidates');
      const urls = new Set();
      for (const candidate of data.products) {
        try {
          const url = new URL(candidate.url);
          if (url.protocol === 'https:' && ['vseinstrumenti.ru','www.vseinstrumenti.ru'].includes(url.hostname) &&
              url.pathname.startsWith('/product/') && !url.port && !url.username && !url.password) urls.add(url.href);
        } catch { /* Invalid provider URL is excluded. */ }
      }
      signal?.throwIfAborted();
      return [...urls].slice(0,limit).map(url=>({url}));
    },
  };
}
