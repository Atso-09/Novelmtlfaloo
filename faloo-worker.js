/**
 * NovelMTL Faloo Fetch Worker
 * Deploy this file as a Cloudflare Worker.
 * Supports publicly accessible Faloo mobile chapter pages only.
 * Does not bypass login, VIP restrictions, CAPTCHAs, or paywalls.
 */
const ALLOWED_HOSTS = new Set(["wap.faloo.com", "www.faloo.com", "faloo.com"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function response(data, status=200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {...CORS, "Content-Type":"application/json; charset=utf-8"}
  });
}
function decodeEntities(s) {
  return s
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_,n)=>String.fromCodePoint(parseInt(n,16)));
}
function htmlToText(html) {
  return decodeEntities(html
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/p\s*>/gi,"\n\n")
    .replace(/<\/div\s*>/gi,"\n")
    .replace(/<[^>]*>/g," ")
    .replace(/[ \t]+\n/g,"\n")
    .replace(/\n[ \t]+/g,"\n")
    .replace(/[ \t]{2,}/g," ")
    .replace(/\n{3,}/g,"\n\n")
  ).trim();
}
function extractChapter(html) {
  const candidates = [
    /<div[^>]+id=["'](?:BookText|bookText|content|chaptercontent|chapterContent)["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class=["'][^"']*(?:Readarea|readarea|chapter-content|read-content|book_text|content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i
  ];
  for (const re of candidates) {
    const m=html.match(re);
    if(m) {
      const cleaned=m[1].replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi,"");
      const text=htmlToText(cleaned);
      if(text.length>150) return text;
    }
  }
  // Faloo markup may change. Fallback: remove page chrome and inspect visible text.
  let body=html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1]||html;
  body=body.replace(/<(script|style|noscript|svg|header|footer|nav|form)[\s\S]*?<\/\1>/gi,"");
  const text=htmlToText(body);
  // Keep fallback bounded and reject pages that look like an access/error screen.
  if(text.length>150) {
    const start=Math.max(text.indexOf("瀑布"), text.indexOf("从本章开始听"));
    const marker=start>=0?start:0;
    const end=text.indexOf("飞卢小说",marker);
    return text.slice(marker,end>marker?end:Math.min(text.length,30000)).trim();
  }
  return "";
}
function chapterTitle(html) {
  const title=html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||"";
  const h1=html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||"";
  return htmlToText(h1)||htmlToText(title).replace(/[_\-].*$/,"").trim()||"Faloo chapter";
}
export default {
  async fetch(request) {
    if(request.method==="OPTIONS") return new Response(null,{headers:CORS});
    if(request.method!=="GET") return response({ok:false,error:"Only GET is supported."},405);
    const incoming=new URL(request.url);
    const target=incoming.searchParams.get("url");
    if(!target) return response({ok:false,error:"Missing ?url= chapter URL."},400);
    let u;
    try { u=new URL(target); } catch { return response({ok:false,error:"Invalid URL."},400); }
    if(u.protocol!=="https:" || !ALLOWED_HOSTS.has(u.hostname) || !/^\/\d+_\d+\.html$/i.test(u.pathname)) {
      return response({ok:false,error:"Only public Faloo mobile chapter URLs are supported."},400);
    }
    try {
      const upstream=await fetch(u.toString(),{
        headers:{
          "User-Agent":"Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/122.0 Mobile Safari/537.36",
          "Accept":"text/html,application/xhtml+xml"
        },
        redirect:"follow"
      });
      if(!upstream.ok) return response({ok:false,error:`Faloo returned HTTP ${upstream.status}. The page may require access or may be temporarily unavailable.`},upstream.status);
      const html=await upstream.text();
      const text=extractChapter(html);
      if(!text || text.length<80) return response({ok:false,error:"Could not identify readable chapter text. Faloo may have changed its page layout or requires a different access method."},422);
      const match=u.pathname.match(/^\/(\d+)_(\d+)\.html$/i);
      const nextUrl=`${u.origin}/${match[1]}_${Number(match[2])+1}.html`;
      return response({ok:true,source:"Faloo",title:chapterTitle(html),text,nextUrl,url:u.toString()});
    } catch(e) {
      return response({ok:false,error:"Worker fetch failed: "+(e?.message||String(e))},502);
    }
  }
};
