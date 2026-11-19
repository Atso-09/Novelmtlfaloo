const $ = id => document.getElementById(id);
const DB_KEY = "novelmtl_v1";
let state = loadState();
let current = null;
let currentView = "en";
let chapterQueue = [];
let chapterHistory = [];
let readerTheme = "night";
let readerFontSize = 19;
let deferredInstall = null;

function loadState(){try{return JSON.parse(localStorage.getItem(DB_KEY)) || {glossary:{"小智":"Ash Ketchum","皮卡丘":"Pikachu"},chapters:[],email:"",workerUrl:""};}catch{return {glossary:{"小智":"Ash Ketchum","皮卡丘":"Pikachu"},chapters:[],email:"",workerUrl:""};}}
function persist(){localStorage.setItem(DB_KEY,JSON.stringify(state)); renderLibrary(); renderGlossary();}
function setStatus(message, bad=false){$("status").textContent=message;$("status").style.color=bad?"#ffaaa9":"#75d6a0";}
function cleanText(s){return (s||"").replace(/\r/g,"").replace(/\u3000/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();}
function paragraphs(s){return cleanText(s).split(/\n+/).map(x=>x.trim()).filter(Boolean);}
function applyGlossary(text){let out=text;const entries=Object.entries(state.glossary||{}).sort((a,b)=>b[0].length-a[0].length);for(const [src,dst] of entries){if(src)out=out.split(src).join(dst);}return out;}
function protectGlossary(text){let out=text, map={},i=0;for(const [src,dst] of Object.entries(state.glossary||{}).sort((a,b)=>b[0].length-a[0].length)){if(!src)continue;const token=`ZXQTERM${i++}QXZ`;if(out.includes(src)){out=out.split(src).join(token);map[token]=dst;}}return {text:out,map};}
function restoreGlossary(text,map){let out=text;for(const [token,value] of Object.entries(map))out=out.split(token).join(value);return out;}
async function translateChunk(text){
  const protectedData=protectGlossary(text);
  const params=new URLSearchParams({q:protectedData.text,langpair:"zh-CN|en"});
  if(state.email)params.set("de",state.email);
  const response=await fetch("https://api.mymemory.translated.net/get?"+params.toString());
  if(!response.ok)throw new Error("Translation service returned HTTP "+response.status);
  const data=await response.json();
  if(data.responseStatus!==200 || !data.responseData?.translatedText)throw new Error(data.responseDetails||"No translation returned.");
  let result=restoreGlossary(data.responseData.translatedText,protectedData.map);
  return result.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">");
}
async function translateText(source){
  const chunks=paragraphs(source);let result=[];
  for(let i=0;i<chunks.length;i++){
    setStatus(`Translating paragraph ${i+1} of ${chunks.length}…`);
    // Keep each request below typical public endpoint limits.
    const pieces=chunks[i].match(/[\s\S]{1,4500}/g)||[];
    for(const piece of pieces)result.push(await translateChunk(piece));
  }
  return result.join("\n\n");
}
function isFalooUrl(url){
  try{const u=new URL(url);return (u.hostname==="wap.faloo.com"||u.hostname==="www.faloo.com"||u.hostname==="faloo.com") && /^\/\d+_\d+\.html$/i.test(u.pathname);}
  catch{return false;}
}
function falooNextUrl(url){
  const u=new URL(url);const m=u.pathname.match(/^\/(\d+)_(\d+)\.html$/i);
  if(!m)return "";
  return `${u.origin}/${m[1]}_${Number(m[2])+1}.html`;
}
async function fetchFalooViaWorker(url){
  const worker=($("workerUrl")?.value||state.workerUrl||"").trim().replace(/\/+$/,"");
  if(!worker)throw new Error("Faloo Worker is not configured yet. Deploy faloo-worker.js and paste its workers.dev URL in Translation settings.");
  const endpoint=worker+"/?url="+encodeURIComponent(url);
  const res=await fetch(endpoint,{method:"GET"});
  if(!res.ok)throw new Error("Faloo Worker returned HTTP "+res.status);
  const data=await res.json();
  if(!data.ok)throw new Error(data.error||"Worker could not extract this Faloo page.");
  return data;
}
async function loadUrl(){
  const url=$("novelUrl").value.trim();if(!url){setStatus("Paste a chapter URL first.",true);return;}
  try{new URL(url);}catch{setStatus("That URL does not look valid.",true);return;}
  setStatus("Trying to fetch the page…");
  try{
    let text="",title="",next="";
    if(isFalooUrl(url)){
      setStatus("Fetching Faloo chapter through your Worker…");
      const data=await fetchFalooViaWorker(url);
      text=cleanText(data.text||"");title=data.title||"Chapter";next=data.nextUrl||falooNextUrl(url);
    }else{
      const res=await fetch(url,{method:"GET"});
      if(!res.ok)throw new Error("Website returned "+res.status);
      const html=await res.text();const doc=new DOMParser().parseFromString(html,"text/html");
      doc.querySelectorAll("script,style,nav,header,footer,aside,form,button").forEach(e=>e.remove());
      const selectors=["#content","#chaptercontent",".chapter-content",".read-content",".content","article","main"];
      let node=null;for(const sel of selectors){node=doc.querySelector(sel);if(node && node.innerText.trim().length>250)break;node=null;}
      if(!node)throw new Error("Could not identify the chapter text.");
      text=cleanText(node.innerText);title=doc.querySelector("h1")?.innerText||doc.title||"Chapter";
      const links=discoverChapterLinks(doc,url);next=links[0]||"";
    }
    if(text.length<80)throw new Error("The page did not contain enough readable text.");
    $("sourceText").value=text;$("chapterTitle").value=title;
    $("novelUrl").dataset.current=url;
    chapterQueue=next?[next]:[];
    setStatus(`Fetched chapter text (${text.length.toLocaleString()} characters). ${next?"Next chapter is ready.":"No next-chapter link detected."}`);
    $("nextBtn").disabled=!next;
  }catch(err){setStatus("Automatic fetch failed: "+err.message+" You can paste the chapter text into the box instead.",true);}
}
function discoverChapterLinks(doc,base){
  const candidates=[...doc.querySelectorAll("a[href]")];
  const scored=candidates.map(a=>({url:new URL(a.getAttribute("href"),base).href,label:(a.innerText+" "+a.getAttribute("rel")).toLowerCase()}))
    .filter(x=>/next|下一章|下章|后一章|下一页/.test(x.label));
  return [...new Set(scored.map(x=>x.url))].slice(0,3);
}
async function translateCurrent(){
  const source=cleanText($("sourceText").value);if(!source){setStatus("Paste chapter text or fetch a chapter first.",true);return;}
  $("translateBtn").disabled=true;
  try{
    const english=await translateText(source);
    const previous=current;
    current={id:Date.now(),title:$("chapterTitle").value.trim()||"Untitled chapter",url:$("novelUrl").dataset.current||$("novelUrl").value.trim(),source,english,created:new Date().toISOString()};
    if(previous && previous.url!==current.url)chapterHistory.push(previous);
    currentView="en";renderReader();document.body.classList.add("reader-mode");setStatus("Translation complete. Your reading view is ready.");
  }catch(err){setStatus("Translation failed: "+err.message+". Try a shorter chapter or try again later.",true);}
  finally{$("translateBtn").disabled=false;}
}
function renderReader(){
  if(!current)return;
  $("readerTitle").textContent=current.title;$("readerMeta").textContent=current.url||"Pasted chapter";
  $("readerContent").textContent=currentView==="en"?current.english:current.source;
  $("showEnglishBtn").classList.toggle("active",currentView==="en");$("showChineseBtn").classList.toggle("active",currentView==="zh");
  $("bookmarkBtn").textContent=state.chapters.some(c=>c.id===current.id)?"★":"☆";
  $("prevBtn").disabled=chapterHistory.length===0;
  const activeUrl=current.url||$("novelUrl").dataset.current||"";
  $("nextBtn").disabled=!(chapterQueue.length||isFalooUrl(activeUrl));
  $("chapterProgress").textContent=chapterHistory.length ? `Chapter ${chapterHistory.length+1}` : "A quiet place to read"; 
  $("readerContent").style.fontSize=readerFontSize+"px";
}
function saveCurrent(){
  if(!current){setStatus("Translate a chapter before saving.",true);return;}
  const idx=state.chapters.findIndex(c=>c.id===current.id);
  if(idx>=0)state.chapters[idx]=current;else state.chapters.unshift(current);
  persist();renderReader();setStatus("Chapter saved on this phone.");
}
function renderGlossary(){
  const entries=Object.entries(state.glossary||{});$("glossaryCount").textContent=entries.length+" terms";
  $("glossaryList").innerHTML="";
  if(!entries.length){$("glossaryList").innerHTML='<p class="empty">No custom terms yet.</p>';return;}
  for(const [src,dst] of entries){const row=document.createElement("div");row.className="term-row";const span=document.createElement("span");span.textContent=src+" → ";const b=document.createElement("b");b.textContent=dst;const del=document.createElement("button");del.className="button ghost small";del.textContent="Remove";del.onclick=()=>{delete state.glossary[src];persist();};row.append(span,b,del);$("glossaryList").append(row);}
}
function renderLibrary(){
  $("savedCount").textContent=state.chapters.length+" chapters";$("libraryList").innerHTML="";
  if(!state.chapters.length){$("libraryList").innerHTML='<p class="empty">Saved chapters will appear here.</p>';return;}
  state.chapters.forEach(ch=>{const row=document.createElement("div");row.className="library-row";const span=document.createElement("span");span.textContent=ch.title;const open=document.createElement("button");open.className="button secondary small";open.textContent="Read";open.onclick=()=>{current=ch;currentView="en";document.body.classList.add("reader-mode");$("sourceText").value=ch.source;$("chapterTitle").value=ch.title;$("novelUrl").value=ch.url||"";renderReader();window.scrollTo({top:$(".reader").offsetTop-75,behavior:"smooth"});};const del=document.createElement("button");del.className="button ghost small";del.textContent="Delete";del.onclick=()=>{state.chapters=state.chapters.filter(x=>x.id!==ch.id);persist();};row.append(span,open,del);$("libraryList").append(row);});
}
function download(name,text,type="text/plain"){const a=document.createElement("a");const blob=new Blob([text],{type});a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);}
$("loadUrlBtn").onclick=loadUrl;$("translateBtn").onclick=translateCurrent;$("saveSourceBtn").onclick=()=>{if(!$("sourceText").value.trim()){setStatus("No source text to save.",true);return;}current={id:Date.now(),title:$("chapterTitle").value||"Source chapter",url:$("novelUrl").value,source:cleanText($("sourceText").value),english:"",created:new Date().toISOString()};saveCurrent();};
$("showEnglishBtn").onclick=()=>{if(current){currentView="en";renderReader();}};$("showChineseBtn").onclick=()=>{if(current){currentView="zh";renderReader();}};
$("bookmarkBtn").onclick=saveCurrent;$("prevBtn").onclick=()=>{if(!chapterHistory.length)return;const old=current;current=chapterHistory.pop();currentView="en";$("sourceText").value=current.source;$("chapterTitle").value=current.title;$("novelUrl").value=current.url||"";if(current.url)$("novelUrl").dataset.current=current.url;renderReader();setStatus("Returned to the previous chapter.");};$("nextBtn").onclick=async()=>{let next=chapterQueue.shift();if(!next && isFalooUrl($("novelUrl").dataset.current||$("novelUrl").value.trim()))next=falooNextUrl($("novelUrl").dataset.current||$("novelUrl").value.trim());if(next){$("novelUrl").value=next;await loadUrl();}else setStatus("No next link found. Paste the next chapter URL above.",true);};
$("copyBtn").onclick=async()=>{if(!current)return;try{await navigator.clipboard.writeText(currentView==="en"?current.english:current.source);setStatus("Chapter copied.");}catch{setStatus("Clipboard permission was not available.",true);}};
$("addGlossaryBtn").onclick=()=>{const a=$("glossarySource").value.trim(),b=$("glossaryTarget").value.trim();if(!a||!b){setStatus("Enter both the Chinese term and its locked English name.",true);return;}state.glossary[a]=b;$("glossarySource").value="";$("glossaryTarget").value="";persist();setStatus("Glossary term added.");};
$("exportGlossaryBtn").onclick=()=>download("novelmtl-glossary.json",JSON.stringify(state.glossary,null,2),"application/json");
$("importGlossaryInput").onchange=async e=>{try{const obj=JSON.parse(await e.target.files[0].text());if(!obj||Array.isArray(obj)||typeof obj!=="object")throw 0;state.glossary={...state.glossary,...obj};persist();setStatus("Glossary imported.");}catch{setStatus("Could not import that JSON glossary.",true);}e.target.value="";};
$("exportChapterBtn").onclick=()=>{if(!current){setStatus("No current chapter to export.",true);return;}download((current.title||"chapter").replace(/[^\w\-]+/g,"_")+".txt",current.title+"\n\n"+current.english+"\n\n--- Original Chinese ---\n\n"+current.source);};
$("emailInput").value=state.email||"";$("emailInput").onchange=()=>{state.email=$("emailInput").value.trim();persist();};
if($("workerUrl")){$("workerUrl").value=state.workerUrl||"";$("workerUrl").onchange=()=>{state.workerUrl=$("workerUrl").value.trim();persist();setStatus("Faloo Worker URL saved on this phone.");};}
$("readerExitBtn").onclick=()=>{document.body.classList.remove("reader-mode");window.scrollTo({top:0,behavior:"smooth"});};
$("fontDownBtn").onclick=()=>{readerFontSize=Math.max(15,readerFontSize-1);$("readerContent").style.fontSize=readerFontSize+"px";};
$("fontUpBtn").onclick=()=>{readerFontSize=Math.min(25,readerFontSize+1);$("readerContent").style.fontSize=readerFontSize+"px";};
$("readerThemeBtn").onclick=()=>{document.body.classList.remove("reader-sepia","reader-light");readerTheme=readerTheme==="night"?"sepia":readerTheme==="sepia"?"light":"night";if(readerTheme==="sepia")document.body.classList.add("reader-sepia");if(readerTheme==="light")document.body.classList.add("reader-light");$("readerThemeBtn").textContent=readerTheme==="night"?"☼ Night":readerTheme==="sepia"?"☼ Sepia":"☼ Day";};
$("clearDataBtn").onclick=()=>{if(confirm("Delete all saved chapters, glossary terms and settings from this browser?")){localStorage.removeItem(DB_KEY);state=loadState();current=null;renderGlossary();renderLibrary();$("readerTitle").textContent="No chapter loaded";$("readerContent").innerHTML='<p class="empty">Your reading page is waiting.</p>';setStatus("Local data cleared.");}};
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredInstall=e;$("installBtn").hidden=false;});
$("installBtn").onclick=async()=>{if(!deferredInstall)return;deferredInstall.prompt();await deferredInstall.userChoice;deferredInstall=null;$("installBtn").hidden=true;};
if("serviceWorker" in navigator && location.protocol.startsWith("http"))window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
renderGlossary();renderLibrary();
