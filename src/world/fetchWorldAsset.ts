export type WorldAssetCompression='none'|'gzip';

interface WorldAssetFetchOptions {
  compression:WorldAssetCompression;
  fetcher?:typeof fetch;
}

/** Pages stores losslessly compressed files explicitly, without relying on
 * configurable HTTP Content-Encoding headers. Decode while the response streams
 * so callers keep the original manifests, buffers, hashes, and failure handling. */
export function createWorldAssetFetcher({compression,fetcher=(url,init)=>fetch(url,init)}:WorldAssetFetchOptions){
  return async(resolvedURL:string,init?:RequestInit):Promise<Response>=>{
    init?.signal?.throwIfAborted();
    if(compression==='none')return fetcher(resolvedURL,init);
    const url=new URL(resolvedURL);
    url.pathname+='.gz';
    const response=await fetcher(url.href,init);
    // Preserve HTTP errors for the existing mandatory/optional resource policy.
    if(!response.ok||!response.body)return response;
    init?.signal?.throwIfAborted();
    const body=response.body.pipeThrough(new DecompressionStream('gzip'),{signal:init?.signal??undefined});
    const headers=new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(body,{status:response.status,statusText:response.statusText,headers});
  };
}

// Local development keeps its existing uncompressed paths. The Pages build opts
// in only when its packaging step has produced every required .gz resource.
export const fetchWorldAsset=createWorldAssetFetcher({
  compression:import.meta.env?.VITE_WORLD_ASSET_COMPRESSION==='gzip'?'gzip':'none',
});
