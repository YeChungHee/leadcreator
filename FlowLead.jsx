import { useState, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ── 세일즈맵 컬럼 ─────────────────────────────────────────
const SM_COLS = [
  "Organization - 이름","Organization - 업종","Organization - 담당자",
  "Organization - 기업형태","Organization - 담당직원(직함)","Organization - 대표자명",
  "Organization - 사업자번호","Organization - 계산서 이메일","Organization - 웹 주소",
  "Organization - 유입경로","Organization - 유입경로_상세","Organization - 전화","Organization - 주소",
];

const MAX_IMG_BYTES = 5 * 1024 * 1024;

const CONF = {
  high:      { bg:"#d1fae5", color:"#065f46", label:"높음" },
  medium:    { bg:"#fef3c7", color:"#92400e", label:"보통" },
  low:       { bg:"#fee2e2", color:"#991b1b", label:"낮음" },
  not_found: { bg:"#f1f5f9", color:"#64748b", label:"미발견" },
};

const SOURCE_BADGE = {
  csv:   { bg:"#dbeafe", color:"#1d4ed8", label:"📄 CSV" },
  image: { bg:"#ede9fe", color:"#6d28d9", label:"🖼 이미지" },
  url:   { bg:"#dcfce7", color:"#15803d", label:"🔗 링크" },
  paste: { bg:"#fef9c3", color:"#854d0e", label:"📋 텍스트" },
};

let _uid = 0;
function mkLead(fields) {
  return { id:++_uid, status:"pending", confidence:null, aiFields:[], ...fields };
}

// ── AI 웹검색 기업정보 조회 ──────────────────────────────
async function lookupBizInfoViaAI(company) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:1500, temperature:0,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      system:`한국 기업 정보를 웹 검색으로 찾아주는 어시스턴트입니다.
다음 순서로 반드시 검색하세요:
1. "{회사명} 사업자등록번호" 검색
2. "{회사명} 대표자 주소" 검색
3. 사람인, 잡코리아, 혁신의숲 등 기업정보 사이트 결과 우선 확인
반드시 순수 JSON만 응답. 마크다운 없이.
형식: {"bizNo":"000-00-00000","ceo":"대표자명","addr":"주소","bizType":"업종","corpType":"기업형태(대기업/중견기업/중소기업/스타트업)","web":"https://...","phone":"","email":"","confidence":"high|medium|low|not_found"}
확인된 값만 입력. 불확실하면 null.`,
      messages:[{role:"user",content:`회사명: "${company}"\n사업자등록번호, 대표자명, 주소, 업종, 기업형태, 홈페이지, 전화번호를 웹 검색으로 찾아주세요.\n사람인(saramin.co.kr), 잡코리아(jobkorea.co.kr), 혁신의숲(innoforest.co.kr) 등에서 확인하세요.`}]
    })
  });
  const data = await res.json();
  const tb = data.content?.find(b=>b.type==="text");
  if (!tb) return {};
  try {
    const raw = tb.text.replace(/```json|```/g,"").trim();
    const s=raw.indexOf("{"), e=raw.lastIndexOf("}");
    if (s===-1||e===-1) return {};
    return JSON.parse(raw.slice(s,e+1));
  } catch { return {}; }
}

// ── 이미지에서 기업정보 추출 ─────────────────────────────
async function extractFromImage(base64, mimeType, onProgress) {
  onProgress?.("이미지 분석 중...");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:4000, temperature:0,
      system:`이미지에서 기업/업체/인물 정보를 추출합니다.
명함, 업체 리스트 표, 인물 명단표(사진+이름+직함+회사명), 브로셔 등 모든 형태 처리.
반드시 순수 JSON 배열만 응답. 마크다운 없이.
형식: [{"company":"회사명","contact":"담당자/이름","jobTitle":"직함","phone":"전화","email":"이메일","addr":"주소","bizType":"업종","web":"홈페이지","ceo":"대표자","bizNo":"사업자번호","corpType":"기업형태","extra":"기타정보"}]
규칙:
- 인물명단표: 이름→contact, 직함→jobTitle, 직함이 대표면 ceo에도 이름 입력
- 사진 컬럼 무시, 텍스트만 추출
- 없는 필드는 "", company 또는 contact 하나라도 있으면 포함
- 모든 행 누락 없이, 헤더 행 제외`,
      messages:[{role:"user",content:[
        {type:"image",source:{type:"base64",media_type:mimeType,data:base64}},
        {type:"text",text:"이미지의 모든 정보를 빠짐없이 추출해주세요. 표/리스트라면 모든 행을 추출하고, 인물 사진은 무시하세요."}
      ]}]
    })
  });
  const data = await res.json();
  if (data.error) { console.error("이미지 API 오류:", data.error); return []; }
  const tb = data.content?.find(b=>b.type==="text");
  if (!tb) return [];
  try {
    const raw = tb.text.replace(/```json|```/g,"").trim();
    const s=raw.indexOf("["), e=raw.lastIndexOf("]");
    if (s===-1||e===-1) return [];
    const arr = JSON.parse(raw.slice(s,e+1));
    const extracted = Array.isArray(arr)?arr:[arr];
    onProgress?.(`${extracted.length}개 추출 완료`);
    return extracted.filter(e=>e.company||e.contact);
  } catch { return []; }
}

// ── 홈페이지 단일 페이지 분석 ────────────────────────────
async function fetchPage(url) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:800, temperature:0,
      tools:[{type:"web_search_20250305",name:"web_search"}],
      system:`주어진 URL을 직접 방문해 기업 정보를 추출합니다.
반드시 순수 JSON만 응답. 마크다운 없이.
형식: {"company":"","phone":"","email":"","addr":"","bizType":"","web":"","ceo":"","bizNo":"","corpType":"","found":true}
실제 확인된 값만 입력. bizNo는 000-00-00000 형식. 없으면 found:false.`,
      messages:[{role:"user",content:`URL: ${url}\n이 페이지를 직접 방문해 기업 정보(사업자번호, 대표자, 주소 등)를 추출해주세요. 페이지 하단(footer)을 특히 확인하세요.`}]
    })
  });
  const data = await res.json();
  const tb = data.content?.find(b=>b.type==="text");
  if (!tb) return null;
  try {
    const raw = tb.text.replace(/```json|```/g,"").trim();
    const s=raw.indexOf("{"), e=raw.lastIndexOf("}");
    if (s===-1||e===-1) return null;
    return JSON.parse(raw.slice(s,e+1));
  } catch { return null; }
}

function mergeInfo(pages) {
  const merged = {};
  for (const page of pages) {
    if (!page) continue;
    for (const f of ["company","phone","email","addr","bizType","web","ceo","bizNo","corpType"]) {
      if (!merged[f] && page[f]) merged[f] = page[f];
    }
  }
  return merged;
}

async function extractFromURL(baseUrl, onProgress) {
  const results = [];
  onProgress?.("메인 페이지 분석 중...");
  const main = await fetchPage(baseUrl);
  if (main) results.push(main);
  let merged = mergeInfo(results);
  const done = () => merged.bizNo && merged.ceo && merged.addr && merged.phone;
  if (done()) { merged.confidence="high"; merged.web=merged.web||baseUrl; return merged; }
  const subs = ["/privacy","/terms","/about","/aboutus","/company","/contact","/introduce"];
  let i=0;
  for (const path of subs) {
    if (i>=4) break;
    onProgress?.(`추가 페이지 확인 중... (${i+1}/4)`);
    try { const r=await fetchPage(baseUrl.replace(/\/$/,"")+path); if(r?.found!==false) results.push(r); merged=mergeInfo(results); if(done()) break; } catch{}
    i++;
  }
  const filled=["company","bizNo","ceo","addr","phone"].filter(f=>merged[f]).length;
  merged.confidence=filled>=4?"high":filled>=2?"medium":"low";
  merged.web=merged.web||baseUrl;
  return Object.keys(merged).length>1?merged:null;
}

// ── CSV 파싱 ─────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n").filter(l=>l.trim());
  if (lines.length<2) return [];
  const hdrs = lines[0].split(",").map(h=>h.trim().toLowerCase());
  const idx = ks => hdrs.findIndex(h=>ks.some(q=>h.includes(q)));
  return lines.slice(1).map(line => {
    const cols = line.split(",").map(c=>c.trim());
    return mkLead({
      company:  cols[idx(["회사","company","기업","이름"])]||cols[0]||"",
      contact:  cols[idx(["담당자","contact","담당"])]||"",
      phone:    cols[idx(["전화","연락","phone","tel"])]||"",
      email:    cols[idx(["이메일","email","mail"])]||"",
      bizNo:    cols[idx(["사업자","bizno"])]||"",
      ceo:      cols[idx(["대표","ceo"])]||"",
      addr:     cols[idx(["주소","addr"])]||"",
      bizType:  cols[idx(["업종","biztype","industry"])]||"",
      corpType: cols[idx(["기업형태","corptype"])]||"",
      web:      cols[idx(["웹","web","url","홈페이지"])]||"",
      jobTitle: cols[idx(["담당직원","직함","title"])]||"",
      source:"csv",
    });
  });
}

function buildRow(l, exhibition) {
  return {
    "Organization - 이름":           l.company    ||"",
    "Organization - 업종":           l.bizType    ||"",
    "Organization - 담당자":         l.contact    ||"",
    "Organization - 기업형태":       l.corpType   ||"",
    "Organization - 담당직원(직함)": l.jobTitle   ||"",
    "Organization - 대표자명":       l.ceo        ||"",
    "Organization - 사업자번호":     l.bizNo      ||"",
    "Organization - 계산서 이메일":  l.email      ||"",
    "Organization - 웹 주소":        l.web        ||"",
    "Organization - 유입경로":       "오프/행사",
    "Organization - 유입경로_상세":  exhibition   ||"",
    "Organization - 전화":           l.phone      ||"",
    "Organization - 주소":           l.addr       ||"",
  };
}

function exportXLSX(leads, exhibition) {
  const rows = leads.map(l=>buildRow(l,exhibition));
  const ws = XLSX.utils.json_to_sheet(rows,{header:SM_COLS});
  ws["!cols"]=SM_COLS.map(c=>({wch:Math.max(c.length+2,18)}));
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,"Organization");
  XLSX.writeFile(wb,`salesmap_${(exhibition||"leads").replace(/\s/g,"_")}.xlsx`);
}

function normalizeURL(raw) {
  let u=raw.trim();
  if (!u.startsWith("http")) u="https://"+u;
  return u;
}

export default function FlowLead() {
  const [leads,       setLeads]       = useState([]);
  const [running,     setRunning]     = useState(false);
  const [tab,         setTab]         = useState("upload");
  const [exhibition,  setExhibition]  = useState("");
  const [skipAI,      setSkipAI]      = useState(false);
  const [selected,    setSelected]    = useState(new Set());
  const [imgPreviews, setImgPreviews] = useState([]);
  const [imgProcessing,setImgProcessing]=useState(false);
  const [urlInput,    setUrlInput]    = useState("");
  const [urlList,     setUrlList]     = useState([]);
  const [urlProcessing,setUrlProcessing]=useState(false);
  const [pasteText,   setPasteText]   = useState("");
  const [pasteProcessing,setPasteProcessing]=useState(false);
  const [storageStatus, setStorageStatus] = useState(""); // "saved" | "loading" | "error" | ""

  const csvRef=useRef(), imgRef=useRef();

  // ── leads/exhibition 변경 시 자동 저장 ────────────────
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return; }
    if (leads.length === 0) return;
    saveToStorage(leads, exhibition);
  }, [leads, exhibition]);

  // ── 저장 / 불러오기 ──────────────────────────────────
  const STORAGE_KEY = "flowlead:leads";
  const EXHB_KEY    = "flowlead:exhibition";

  const saveToStorage = async (leadsData, exhb) => {
    try {
      await window.storage.set(STORAGE_KEY, JSON.stringify(leadsData));
      await window.storage.set(EXHB_KEY,    exhb || "");
      setStorageStatus("saved");
      setTimeout(() => setStorageStatus(""), 2000);
    } catch (e) { console.error("저장 실패", e); setStorageStatus("error"); }
  };

  // 최초 마운트 시 복원
  const loaded = useRef(false);
  useState(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      try {
        setStorageStatus("loading");
        const r1 = await window.storage.get(STORAGE_KEY);
        const r2 = await window.storage.get(EXHB_KEY);
        if (r1?.value) {
          const saved = JSON.parse(r1.value);
          if (Array.isArray(saved) && saved.length > 0) {
            setLeads(saved);
            setTab("results");
          }
        }
        if (r2?.value) setExhibition(r2.value);
        setStorageStatus("");
      } catch { setStorageStatus(""); }
    })();
  });

  // ── CSV ──────────────────────────────────────────────
  const handleCSV = e => {
    const f=e.target.files?.[0]; if(!f) return;
    const r=new FileReader();
    r.onload=ev=>{
      const parsed=parseCSV(ev.target.result);
      if(!parsed.length) return alert("CSV 형식을 확인해주세요.");
      setLeads(p=>[...p,...parsed]); setTab("results");
    };
    r.readAsText(f,"UTF-8"); e.target.value="";
  };

  // ── 이미지 ───────────────────────────────────────────
  const handleImages = async files => {
    if (!files?.length) return;
    setImgProcessing(true);
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      // FileReader로 dataURL 생성 (미리보기 + base64 겸용)
      const dataUrl = await new Promise(res => {
        const r=new FileReader();
        r.onload=e=>res(e.target.result);
        r.onerror=()=>res(null);
        r.readAsDataURL(file);
      });
      if (!dataUrl) continue;
      const previewUrl = dataUrl; // dataURL을 미리보기에도 사용
      setImgPreviews(p=>[...p,{url:previewUrl,name:file.name,status:"processing",progress:"준비 중..."}]);
      try {
        if (file.size > MAX_IMG_BYTES) {
          setImgPreviews(p=>p.map(pr=>pr.url===previewUrl?{...pr,status:"error",progress:`${(file.size/1024/1024).toFixed(1)}MB → 5MB 초과. squoosh.app 압축 후 재업로드`}:pr));
          continue;
        }
        const comma=dataUrl.indexOf(",");
        const b64=dataUrl.slice(comma+1);
        const mime=file.type||"image/jpeg";
        setImgPreviews(p=>p.map(pr=>pr.url===previewUrl?{...pr,progress:"AI 분석 중..."}:pr));
        const extracted=await extractFromImage(b64,mime,msg=>{
          setImgPreviews(p=>p.map(pr=>pr.url===previewUrl?{...pr,progress:msg}:pr));
        });
        let final=extracted;
        if (!extracted.length) {
          setImgPreviews(p=>p.map(pr=>pr.url===previewUrl?{...pr,progress:"재시도 중..."}:pr));
          final=await extractFromImage(b64,mime,()=>{});
        }
        const newLeads=final.map(e=>mkLead({
          company:e.company||"",contact:e.contact||"",phone:e.phone||"",
          email:e.email||"",jobTitle:e.jobTitle||"",addr:e.addr||"",
          bizType:e.bizType||"",web:e.web||"",ceo:e.ceo||"",
          bizNo:e.bizNo||"",corpType:e.corpType||"",source:"image",status:"pending",
        }));
        setLeads(p=>[...p,...newLeads]);
        setImgPreviews(p=>p.map(pr=>pr.url===previewUrl?{...pr,status:final.length>0?"done":"error",count:newLeads.length,progress:""}:pr));
      } catch(e) {
        setImgPreviews(p=>p.map(pr=>pr.url===previewUrl?{...pr,status:"error",progress:e.message||"오류"}:pr));
      }
    }
    setImgProcessing(false);
    setTab("results");
  };

  // ── 텍스트 붙여넣기 ──────────────────────────────────
  const processPasteText = async () => {
    if (!pasteText.trim()) return;
    setPasteProcessing(true);
    try {
      const res=await fetch("https://api.anthropic.com/v1/messages",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",max_tokens:4000,temperature:0,
          system:`텍스트에서 기업/인물 정보를 추출합니다. 표, 명단, 리스트 모든 형태 처리.
반드시 순수 JSON 배열만 응답. 마크다운 없이.
형식: [{"company":"회사명","contact":"담당자/이름","jobTitle":"직함","phone":"전화","email":"이메일","addr":"주소","bizType":"업종","web":"홈페이지","ceo":"대표자","bizNo":"사업자번호","corpType":"기업형태","extra":"기타"}]
없는 필드는 "". company 또는 contact 중 하나라도 있으면 포함. 직함이 대표면 ceo에도 이름 입력.`,
          messages:[{role:"user",content:`다음 텍스트에서 모든 기업/인물 정보를 추출해주세요:\n\n${pasteText}`}]
        })
      });
      const data=await res.json();
      const tb=data.content?.find(b=>b.type==="text");
      if (tb) {
        const raw=tb.text.replace(/```json|```/g,"").trim();
        const s=raw.indexOf("["),e=raw.lastIndexOf("]");
        if (s!==-1&&e!==-1) {
          const arr=JSON.parse(raw.slice(s,e+1));
          const newLeads=arr.filter(e=>e.company||e.contact).map(e=>mkLead({...e,source:"paste"}));
          setLeads(p=>[...p,...newLeads]);
          setPasteText(""); setTab("results");
        }
      }
    } catch(e){alert("파싱 실패: "+e.message);}
    setPasteProcessing(false);
  };

  // ── URL 추가/처리 ─────────────────────────────────────
  const addURLs = () => {
    const urls=urlInput.split("\n").map(s=>s.trim()).filter(Boolean);
    if (!urls.length) return;
    setUrlList(p=>[...p,...urls.map(u=>({url:normalizeURL(u),status:"pending",company:"",progress:""}))]);
    setUrlInput("");
  };

  const processURLs = async () => {
    const pending=urlList.filter(u=>u.status==="pending");
    if (!pending.length) return;
    setUrlProcessing(true);
    for (const item of pending) {
      setUrlList(p=>p.map(u=>u.url===item.url?{...u,status:"processing",progress:"분석 시작..."}:u));
      try {
        const info=await extractFromURL(item.url,msg=>{
          setUrlList(p=>p.map(u=>u.url===item.url?{...u,progress:msg}:u));
        });
        if (info&&info.company) {
          const missing=["bizNo","ceo","addr","bizType","corpType"].some(f=>!info[f]);
          const aiFields=[];
          if (missing) {
            setUrlList(p=>p.map(u=>u.url===item.url?{...u,progress:`'${info.company}' 추가 검색 중...`}:u));
            const extra=await lookupBizInfoViaAI(info.company);
            ["bizNo","ceo","addr","bizType","corpType","web"].forEach(f=>{
              if(!info[f]&&extra[f]){info[f]=extra[f];aiFields.push(f);}
            });
          }
          const lead=mkLead({
            company:info.company||"",contact:"",phone:info.phone||"",email:info.email||"",
            jobTitle:"",addr:info.addr||"",bizType:info.bizType||"",web:info.web||item.url,
            ceo:info.ceo||"",bizNo:info.bizNo||"",corpType:info.corpType||"",
            source:"url",confidence:info.confidence||"medium",aiFields,status:"done",
          });
          setLeads(p=>[...p,lead]);
          setUrlList(p=>p.map(u=>u.url===item.url?{...u,status:"done",company:info.company,progress:""}:u));
        } else {
          setUrlList(p=>p.map(u=>u.url===item.url?{...u,status:"error",progress:""}:u));
        }
      } catch {
        setUrlList(p=>p.map(u=>u.url===item.url?{...u,status:"error",progress:""}:u));
      }
    }
    setUrlProcessing(false);
    setTab("results");
  };

  // ── 선택 AI 조회 ─────────────────────────────────────
  const toggleSelect = id => setSelected(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});
  const toggleAll = () => {
    const pending=leads.filter(l=>l.status!=="done"&&l.status!=="lookup");
    setSelected(selected.size===pending.length?new Set():new Set(pending.map(l=>l.id)));
  };

  const runSelected = async () => {
    if (running||selected.size===0) return;
    setRunning(true);
    for (const lead of leads.filter(l=>selected.has(l.id))) {
      if (skipAI){setLeads(p=>p.map(l=>l.id===lead.id?{...l,status:"done"}:l));continue;}
      try {
        setLeads(p=>p.map(l=>l.id===lead.id?{...l,status:"lookup"}:l));
        const info=await lookupBizInfoViaAI(lead.company);
        const aiFields=[];
        ["bizNo","ceo","addr","bizType","corpType","web","phone","email"].forEach(f=>{
          if(!lead[f]&&info[f]) aiFields.push(f);
        });
        setLeads(p=>p.map(l=>l.id===lead.id?{
          ...l,status:"done",
          bizNo:   l.bizNo   ||info.bizNo   ||"",
          ceo:     l.ceo     ||info.ceo     ||"",
          addr:    l.addr    ||info.addr    ||"",
          bizType: l.bizType ||info.bizType ||"",
          corpType:l.corpType||info.corpType||"",
          web:     l.web     ||info.web     ||"",
          email:   l.email   ||info.email   ||"",
          phone:   l.phone   ||info.phone   ||"",
          confidence:info.confidence||"not_found",aiFields,
        }:l));
      } catch {
        setLeads(p=>p.map(l=>l.id===lead.id?{...l,status:"error"}:l));
      }
    }
    setSelected(new Set()); setRunning(false);
  };

  const total=leads.length;
  const done=leads.filter(l=>l.status==="done").length;
  const fromImg=leads.filter(l=>l.source==="image").length;
  const fromCSV=leads.filter(l=>l.source==="csv").length;
  const fromURL=leads.filter(l=>l.source==="url").length;
  const fromPaste=leads.filter(l=>l.source==="paste").length;

  return (
    <div style={{fontFamily:"'Inter',sans-serif",background:"#f8fafc",minHeight:"100vh",color:"#1e293b"}}>
      {/* Header */}
      <div style={{background:"#0f172a",padding:"16px 24px",display:"flex",alignItems:"center",gap:12}}>
        <div style={{background:"#3b82f6",borderRadius:8,padding:"6px 10px",fontWeight:700,color:"#fff",fontSize:14}}>FL</div>
        <div>
          <div style={{color:"#fff",fontWeight:700,fontSize:16}}>FlowLead</div>
          <div style={{color:"#94a3b8",fontSize:11}}>전시회 리드 → AI 조회 → 세일즈맵 엑셀</div>
        </div>
        {storageStatus==="saved"  && <span style={{marginLeft:8,fontSize:11,color:"#6ee7b7",background:"#064e3b",borderRadius:4,padding:"2px 8px"}}>💾 저장됨</span>}
        {storageStatus==="loading"&& <span style={{marginLeft:8,fontSize:11,color:"#93c5fd"}}>⏳ 불러오는 중...</span>}
        {storageStatus==="error"  && <span style={{marginLeft:8,fontSize:11,color:"#fca5a5"}}>⚠ 저장 실패</span>}
        {total>0&&(
          <div style={{marginLeft:"auto",display:"flex",gap:16}}>
            {[["총",total,"#fff"],["CSV",fromCSV,"#93c5fd"],["이미지",fromImg,"#c4b5fd"],["링크",fromURL,"#6ee7b7"],["텍스트",fromPaste,"#fde68a"],["완료",done,"#10b981"]].map(([k,v,c])=>(
              <div key={k} style={{textAlign:"center"}}>
                <div style={{color:c,fontWeight:700,fontSize:17}}>{v}</div>
                <div style={{color:"#64748b",fontSize:10}}>{k}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{background:"#fff",borderBottom:"1px solid #e2e8f0",padding:"0 24px",display:"flex"}}>
        {[["upload","📁 업로드"],["results",`📊 결과${total>0?` (${done}/${total})`:""}`]].map(([key,label])=>(
          <button key={key} onClick={()=>setTab(key)} style={{padding:"12px 20px",border:"none",background:"none",cursor:"pointer",borderBottom:tab===key?"2px solid #3b82f6":"2px solid transparent",color:tab===key?"#3b82f6":"#64748b",fontWeight:tab===key?600:400,fontSize:14}}>{label}</button>
        ))}
      </div>

      <div style={{padding:24,maxWidth:1200,margin:"0 auto"}}>
        {tab==="upload"&&(
          <div>
            {/* 전시회 정보 */}
            <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,padding:20,marginBottom:16}}>
              <div style={{fontWeight:600,fontSize:14,marginBottom:12}}>🏛️ 전시회 정보</div>
              <div style={{display:"flex",gap:12}}>
                <div style={{flex:2}}>
                  <label style={{fontSize:12,color:"#64748b",display:"block",marginBottom:4}}>전시회명 (유입경로_상세)</label>
                  <input value={exhibition} onChange={e=>setExhibition(e.target.value)} placeholder="예: 2025 스마트팩토리엑스포" style={{width:"100%",padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:14,boxSizing:"border-box"}}/>
                </div>
                <div style={{flex:1}}>
                  <label style={{fontSize:12,color:"#64748b",display:"block",marginBottom:4}}>유입경로 고정값</label>
                  <input disabled value="오프/행사" style={{width:"100%",padding:"8px 12px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:14,boxSizing:"border-box",background:"#f8fafc",color:"#94a3b8"}}/>
                </div>
              </div>
              <div style={{marginTop:12,display:"flex",alignItems:"center",gap:8}}>
                <input type="checkbox" id="skipAI" checked={skipAI} onChange={e=>setSkipAI(e.target.checked)} style={{cursor:"pointer"}}/>
                <label htmlFor="skipAI" style={{fontSize:13,color:"#475569",cursor:"pointer"}}>AI 조회 건너뛰기 — 입력 데이터만으로 즉시 엑셀 생성</label>
              </div>
            </div>

            {/* 업로드 4종 */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
              {/* CSV */}
              <div onClick={()=>csvRef.current.click()} style={{border:"2px dashed #cbd5e1",borderRadius:12,padding:"28px 16px",textAlign:"center",background:"#fff",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.borderColor="#3b82f6"} onMouseLeave={e=>e.currentTarget.style.borderColor="#cbd5e1"}>
                <div style={{fontSize:32,marginBottom:8}}>📄</div>
                <div style={{fontWeight:600,fontSize:14,marginBottom:4}}>CSV 업로드</div>
                <div style={{color:"#94a3b8",fontSize:11}}>회사명, 담당자, 전화, 이메일 등</div>
                <input ref={csvRef} type="file" accept=".csv" onChange={handleCSV} style={{display:"none"}}/>
              </div>

              {/* 이미지 */}
              <div onClick={()=>imgRef.current.click()}
                onDragOver={e=>{e.preventDefault();e.currentTarget.style.borderColor="#3b82f6";e.currentTarget.style.background="#eff6ff";}}
                onDragLeave={e=>{e.currentTarget.style.borderColor="#cbd5e1";e.currentTarget.style.background="#fff";}}
                onDrop={e=>{e.preventDefault();e.currentTarget.style.borderColor="#cbd5e1";e.currentTarget.style.background="#fff";handleImages(e.dataTransfer.files);}}
                style={{border:"2px dashed #cbd5e1",borderRadius:12,padding:"28px 16px",textAlign:"center",background:"#fff",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.borderColor="#3b82f6"} onMouseLeave={e=>e.currentTarget.style.borderColor="#cbd5e1"}>
                <div style={{fontSize:32,marginBottom:8}}>🖼️</div>
                <div style={{fontWeight:600,fontSize:14,marginBottom:4}}>이미지 업로드 <span style={{fontSize:11,color:"#ef4444"}}>5MB 이하</span></div>
                <div style={{color:"#94a3b8",fontSize:11}}>명함·표·브로셔 (JPG·PNG)</div>
                {imgProcessing&&<div style={{marginTop:6,color:"#3b82f6",fontSize:11}}>🔍 분석 중...</div>}
                <input ref={imgRef} type="file" accept="image/*" multiple onChange={e=>handleImages(e.target.files)} style={{display:"none"}}/>
              </div>

              {/* 링크 */}
              <div style={{border:"2px dashed #cbd5e1",borderRadius:12,padding:"20px 16px",background:"#fff"}} onMouseEnter={e=>e.currentTarget.style.borderColor="#10b981"} onMouseLeave={e=>e.currentTarget.style.borderColor="#cbd5e1"}>
                <div style={{textAlign:"center",fontSize:30,marginBottom:6}}>🔗</div>
                <div style={{fontWeight:600,fontSize:14,marginBottom:4,textAlign:"center"}}>링크 입력</div>
                <div style={{color:"#94a3b8",fontSize:11,textAlign:"center",marginBottom:8}}>회사 홈페이지 URL (줄바꿈으로 여러 개)</div>
                <textarea value={urlInput} onChange={e=>setUrlInput(e.target.value)} placeholder={"https://www.example.com\nhttps://www.company.co.kr"} rows={3} style={{width:"100%",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:12,boxSizing:"border-box",resize:"none",fontFamily:"monospace"}}/>
                <button onClick={addURLs} disabled={!urlInput.trim()} style={{width:"100%",marginTop:8,background:urlInput.trim()?"#10b981":"#94a3b8",color:"#fff",border:"none",borderRadius:8,padding:"8px",cursor:urlInput.trim()?"pointer":"default",fontWeight:600,fontSize:13}}>+ URL 추가</button>
              </div>

              {/* 텍스트 붙여넣기 */}
              <div style={{border:"2px dashed #cbd5e1",borderRadius:12,padding:"20px 16px",background:"#fff"}} onMouseEnter={e=>e.currentTarget.style.borderColor="#f59e0b"} onMouseLeave={e=>e.currentTarget.style.borderColor="#cbd5e1"}>
                <div style={{textAlign:"center",fontSize:30,marginBottom:6}}>📋</div>
                <div style={{fontWeight:600,fontSize:14,marginBottom:4,textAlign:"center"}}>텍스트 붙여넣기</div>
                <div style={{color:"#94a3b8",fontSize:11,textAlign:"center",marginBottom:8}}>표/명단 복사 붙여넣기 — <b>5MB 초과 이미지 대안</b></div>
                <textarea value={pasteText} onChange={e=>setPasteText(e.target.value)} placeholder={"이름\t직함\t회사명\t전화\t이메일\n홍길동\t대표\t(주)예시\t010-0000-0000\thong@ex.com"} rows={3} style={{width:"100%",padding:"7px 10px",border:"1px solid #e2e8f0",borderRadius:8,fontSize:12,boxSizing:"border-box",resize:"none",fontFamily:"monospace"}}/>
                <button onClick={processPasteText} disabled={!pasteText.trim()||pasteProcessing} style={{width:"100%",marginTop:8,background:pasteText.trim()&&!pasteProcessing?"#f59e0b":"#94a3b8",color:"#fff",border:"none",borderRadius:8,padding:"8px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                  {pasteProcessing?"⏳ 파싱 중...":"📋 텍스트에서 추출"}
                </button>
              </div>
            </div>

            {/* URL 대기 목록 */}
            {urlList.length>0&&(
              <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,padding:16,marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontWeight:600,fontSize:13}}>🔗 링크 목록 ({urlList.length}개)</div>
                  <button onClick={processURLs} disabled={urlProcessing||urlList.every(u=>u.status!=="pending")} style={{background:urlProcessing||urlList.every(u=>u.status!=="pending")?"#94a3b8":"#10b981",color:"#fff",border:"none",borderRadius:6,padding:"6px 14px",cursor:"pointer",fontWeight:600,fontSize:13}}>
                    {urlProcessing?"🔍 분석 중...":"▶ 전체 분석"}
                  </button>
                </div>
                {urlList.map((u,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 10px",background:"#f8fafc",borderRadius:8,fontSize:12,marginBottom:4}}>
                    <span style={{flex:1,fontFamily:"monospace",color:"#334155",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.url}</span>
                    {u.status==="processing"&&u.progress&&<span style={{color:"#3b82f6",fontSize:11,whiteSpace:"nowrap"}}>{u.progress}</span>}
                    {u.company&&<span style={{color:"#475569",fontWeight:500,whiteSpace:"nowrap"}}>{u.company}</span>}
                    <span style={{fontWeight:600,whiteSpace:"nowrap",color:u.status==="done"?"#10b981":u.status==="error"?"#ef4444":u.status==="processing"?"#3b82f6":"#94a3b8"}}>
                      {u.status==="pending"?"대기":u.status==="processing"?"🔍":u.status==="done"?"✓":"✗"}
                    </span>
                    {u.status==="pending"&&<button onClick={()=>setUrlList(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:14}}>×</button>}
                  </div>
                ))}
              </div>
            )}

            {/* 이미지 미리보기 */}
            {imgPreviews.length>0&&(
              <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,padding:16,marginBottom:16}}>
                <div style={{fontWeight:600,fontSize:13,marginBottom:10}}>🖼️ 업로드된 이미지</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:10}}>
                  {imgPreviews.map((img,i)=>(
                    <div key={i} style={{width:90}}>
                      <img src={img.url} alt={img.name} style={{width:90,height:70,objectFit:"cover",borderRadius:8,border:"1px solid #e2e8f0"}}/>
                      <div style={{marginTop:3,fontSize:10,color:"#64748b",textAlign:"center",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{img.name}</div>
                      <div style={{textAlign:"center",fontSize:10,fontWeight:600,color:img.status==="done"?"#10b981":img.status==="error"?"#ef4444":"#3b82f6"}}>
                        {img.status==="processing"?(img.progress||"분석중..."):img.status==="done"?`✓ ${img.count}건`:img.progress||"✗ 실패"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 5MB 안내 */}
            <div style={{background:"#fef3c7",border:"1px solid #fcd34d",borderRadius:10,padding:"10px 16px",fontSize:12,color:"#92400e",marginBottom:16}}>
              <b>⚠️ 이미지 5MB 제한</b> — 초과 시: ① <a href="https://squoosh.app" target="_blank" rel="noreferrer" style={{color:"#1d4ed8"}}>squoosh.app</a> 무료 압축 후 업로드, 또는 ② 텍스트 붙여넣기 사용
            </div>

            {/* 샘플 CSV */}
            <div style={{background:"#fff",borderRadius:12,border:"1px solid #e2e8f0",padding:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontWeight:600,fontSize:13}}>📋 샘플 CSV</div>
                <button onClick={()=>{const s=`회사명,담당자,전화,이메일\n당호제지,홍길동,010-1234-5678,hong@dangho.com\n삼성전자,김철수,010-2345-6789,kim@samsung.com`;setLeads(p=>[...p,...parseCSV(s)]);setTab("results");}} style={{background:"#3b82f6",color:"#fff",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:12}}>샘플 불러오기</button>
              </div>
              <pre style={{background:"#f8fafc",borderRadius:8,padding:12,fontSize:11,color:"#475569",overflow:"auto",margin:0}}>{`회사명,담당자,전화,이메일\n당호제지,홍길동,010-1234-5678,hong@dangho.com\n삼성전자,김철수,010-2345-6789,kim@samsung.com`}</pre>
            </div>
          </div>
        )}

        {tab==="results"&&(
          <div>
            {total===0?(
              <div style={{textAlign:"center",padding:"60px 0",color:"#94a3b8"}}>
                <div style={{fontSize:40,marginBottom:12}}>📭</div>
                <div>업로드된 리드가 없습니다.</div>
                <button onClick={()=>setTab("upload")} style={{marginTop:16,background:"#3b82f6",color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontWeight:500}}>업로드하기</button>
              </div>
            ):(
              <>
                <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
                  <span style={{fontSize:12,color:"#64748b",whiteSpace:"nowrap"}}>🏛️ 전시회명</span>
                  <input value={exhibition} onChange={e=>setExhibition(e.target.value)} placeholder="전시회명 입력" style={{flex:2,minWidth:160,padding:"6px 10px",border:"1px solid #e2e8f0",borderRadius:6,fontSize:13}}/>
                  <span style={{fontSize:12,color:"#94a3b8",background:"#f1f5f9",borderRadius:4,padding:"4px 8px",whiteSpace:"nowrap"}}>유입경로: 오프/행사 고정</span>
                </div>

                <div style={{display:"flex",gap:10,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
                  {selected.size>0?(
                    <button onClick={runSelected} disabled={running} style={{background:running?"#94a3b8":"#6366f1",color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:running?"default":"pointer",fontWeight:700,fontSize:14}}>
                      🔍 선택 {selected.size}건 AI 분석
                    </button>
                  ):(
                    <button onClick={()=>setSelected(new Set(leads.filter(l=>l.status==="pending"||l.status==="error").map(l=>l.id)))} disabled={running} style={{background:"#3b82f6",color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:14}}>
                      전체 선택
                    </button>
                  )}
                  <button onClick={()=>exportXLSX(leads,exhibition)} style={{background:"#10b981",color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",cursor:"pointer",fontWeight:600,fontSize:14}}>
                    ⬇ 세일즈맵 엑셀 ({total}건)
                  </button>
                  <button onClick={()=>setTab("upload")} style={{background:"#fff",color:"#64748b",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 16px",cursor:"pointer",fontSize:14}}>+ 추가</button>
                  <button onClick={async ()=>{setLeads([]);setSelected(new Set());setImgPreviews([]);setUrlList([]);setTab("upload");isFirst.current=true;try{await window.storage.delete(STORAGE_KEY);await window.storage.delete(EXHB_KEY);}catch{}}} style={{background:"#fff",color:"#ef4444",border:"1px solid #fecaca",borderRadius:8,padding:"10px 16px",cursor:"pointer",fontSize:14}}>초기화</button>
                  {running&&<div style={{fontSize:13,color:"#64748b"}}>{done}/{total} 완료</div>}
                </div>

                <div style={{background:"#fff",borderRadius:12,border:"1px solid #e2e8f0",overflow:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:1000}}>
                    <thead>
                      <tr style={{background:"#f8fafc"}}>
                        <th style={{padding:"10px 12px",borderBottom:"1px solid #e2e8f0",width:36}}>
                          <input type="checkbox" checked={selected.size>0&&selected.size===leads.filter(l=>l.status!=="done"&&l.status!=="lookup").length} onChange={toggleAll} style={{cursor:"pointer"}}/>
                        </th>
                        {["출처","회사명","담당자","직함","전화","이메일","사업자번호","대표자","업종","웹주소","주소","신뢰도","상태"].map(h=>(
                          <th key={h} style={{padding:"10px 10px",textAlign:"left",fontWeight:600,color:"#475569",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {leads.map((l,i)=>{
                        const conf=CONF[l.confidence];
                        const src=SOURCE_BADGE[l.source];
                        const ai=f=>l.aiFields?.includes(f);
                        const isDone=l.status==="done"||l.status==="lookup";
                        const isChecked=selected.has(l.id);
                        return (
                          <tr key={l.id} onClick={()=>!isDone&&toggleSelect(l.id)} style={{borderBottom:"1px solid #f1f5f9",background:isChecked?"#eff6ff":i%2===0?"#fff":"#fafafa",cursor:isDone?"default":"pointer"}}>
                            <td style={{padding:"8px 12px"}}>
                              {!isDone?<input type="checkbox" checked={isChecked} onChange={()=>toggleSelect(l.id)} onClick={e=>e.stopPropagation()} style={{cursor:"pointer"}}/>:<span style={{color:"#10b981"}}>✓</span>}
                            </td>
                            <td style={{padding:"8px 10px"}}><span style={{fontSize:10,padding:"2px 6px",borderRadius:4,fontWeight:600,background:src?.bg,color:src?.color}}>{src?.label}</span></td>
                            <td style={{padding:"8px 10px",fontWeight:500}}>{l.company}</td>
                            <td style={{padding:"8px 10px",color:"#475569"}}>{l.contact||"—"}</td>
                            <td style={{padding:"8px 10px",color:"#475569"}}>{l.jobTitle||"—"}</td>
                            <td style={{padding:"8px 10px",color:ai("phone")?"#2563eb":"#475569"}}>{l.phone||"—"}</td>
                            <td style={{padding:"8px 10px",color:ai("email")?"#2563eb":"#475569"}}>{l.email||"—"}</td>
                            <td style={{padding:"8px 10px",fontFamily:"monospace",color:ai("bizNo")?"#2563eb":"#334155"}}>{l.bizNo||<span style={{color:"#cbd5e1"}}>—</span>}</td>
                            <td style={{padding:"8px 10px",color:ai("ceo")?"#2563eb":"#475569"}}>{l.ceo||<span style={{color:"#cbd5e1"}}>—</span>}</td>
                            <td style={{padding:"8px 10px",color:ai("bizType")?"#2563eb":"#475569"}}>{l.bizType||<span style={{color:"#cbd5e1"}}>—</span>}</td>
                            <td style={{padding:"8px 10px",maxWidth:110,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                              {l.web?<a href={l.web.startsWith("http")?l.web:"https://"+l.web} target="_blank" rel="noreferrer" style={{color:ai("web")?"#2563eb":"#3b82f6",textDecoration:"none"}}>{l.web.replace(/https?:\/\//,"")}</a>:<span style={{color:"#cbd5e1"}}>—</span>}
                            </td>
                            <td style={{padding:"8px 10px",color:ai("addr")?"#2563eb":"#475569",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.addr||<span style={{color:"#cbd5e1"}}>—</span>}</td>
                            <td style={{padding:"8px 10px"}}>
                              {conf?<span style={{background:conf.bg,color:conf.color,padding:"2px 7px",borderRadius:4,fontSize:10,fontWeight:600}}>{conf.label}</span>:<span style={{color:"#cbd5e1"}}>—</span>}
                            </td>
                            <td style={{padding:"8px 10px"}}>
                              {l.status==="pending"&&<span style={{color:"#94a3b8"}}>대기</span>}
                              {l.status==="lookup"&&<span style={{color:"#6366f1"}}>🔍</span>}
                              {l.status==="done"&&<span style={{color:"#10b981"}}>✓</span>}
                              {l.status==="error"&&<span style={{color:"#ef4444",cursor:"pointer"}} onClick={e=>{e.stopPropagation();toggleSelect(l.id);}}>↺ 재시도</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
