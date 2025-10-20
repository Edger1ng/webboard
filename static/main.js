let GRID, EDIT=false, PRESETS=[];
const INTERVAL_MS=1000, MAX_POINTS=180;

function el(tag,cls){const e=document.createElement(tag);if(cls)e.className=cls;return e;}
function card(title, inner){
  const c=el('div','card');
  const head=el('div','drag-handle'); const h=el('h2'); h.textContent=title; head.appendChild(h);
  c.appendChild(head);
  const b=el('div','body'); if(typeof inner==='string'){b.innerHTML=inner;} else {b.appendChild(inner);} c.appendChild(b);
  return c;

function readCookie(name){
  const m=document.cookie.match(new RegExp('(^|; )'+name+'=([^;]*)'));
  return m?decodeURIComponent(m[2]):'';
}

async function api(u, opts){
  const h=(opts&&opts.headers)?opts.headers:{};
  const csrf=readCookie('csrf_token');
  const isUnsafe=(opts&&opts.method)&&!/^(GET|HEAD|OPTIONS|TRACE)$/i.test(opts.method);
  const headers=Object.assign({}, h, isUnsafe?{'X-CSRFToken':csrf}:{});
  const r=await fetch(u,Object.assign({cache:'no-store',headers:headers},opts||{}));
  if(!r.ok) throw new Error(r.statusText);
  const ct=r.headers.get('content-type')||'';
  if(ct.includes('application/json')) return r.json();
  return r.text();
}


async function getLayout(){return api('/api/layout');}
async function saveLayout(layout){return api('/api/layout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(layout)});}
async function getPresets(){return api('/api/presets');}
async function savePreset(name, layout){return api('/api/presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,layout})});}
async function deletePreset(id){return api('/api/presets?id='+id,{method:'DELETE'});}

function buildCoreDefs(){
  return [
    {id:'card_cpu',   title:'CPU (%)',          html:'<canvas id="cpuChart"></canvas>',  minW:4,minH:4},
    {id:'card_ram',   title:'RAM (%)',          html:'<canvas id="ramChart"></canvas>',  minW:4,minH:4},
    {id:'card_net',   title:'Network (Mbit/s)', html:'<canvas id="netChart"></canvas>',  minW:4,minH:3},
    {id:'card_procs', title:'Top Processes',    html:'<table id="procTable"><thead><tr><th>PID</th><th>Name</th><th>CPU%</th><th>RAM%</th></tr></thead><tbody></tbody></table>', minW:4,minH:3}
  ];
}

function gradientStroke(ctx, c1, c2){const g=ctx.createLinearGradient(0,0,0,ctx.canvas.height||200);g.addColorStop(0,c1);g.addColorStop(1,c2);return g;}
function gradientFill(ctx, c1){const g=ctx.createLinearGradient(0,0,0,ctx.canvas.height||200);g.addColorStop(0,c1);g.addColorStop(1,'rgba(0,0,0,0)');return g;}

const TooltipEl=(()=>{const d=document.createElement('div');d.id='chart-tooltip';d.style.position='fixed';d.style.pointerEvents='none';d.style.zIndex='1000';d.style.padding='8px 10px';d.style.borderRadius='10px';d.style.fontSize='12px';d.style.fontWeight='600';d.style.backdropFilter='saturate(140%) blur(8px)';d.style.WebkitBackdropFilter='saturate(140%) blur(8px)';d.style.border='1px solid rgba(128,128,160,.25)';d.style.boxShadow='0 10px 24px rgba(0,0,0,.25)';d.style.display='none';document.addEventListener('DOMContentLoaded',()=>document.body.appendChild(d));return d;})();

let ACTIVE_CHART=null;

const CrosshairPlugin={
  id:'crosshair',
  afterDatasetsDraw(chart){
    if(ACTIVE_CHART!==chart) return;
    const tt=chart.tooltip;
    if(!tt?.getActiveElements()?.length) return;
    const ctx=chart.ctx, area=chart.chartArea;
    const x=tt.caretX;
    ctx.save();
    ctx.strokeStyle='rgba(148,163,184,.45)';
    ctx.setLineDash([3,3]);
    ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(x, area.top);
    ctx.lineTo(x, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
  afterEvent(chart, args){
    const e=args.event;
    const tt=chart.tooltip;
    if(e.type==='mousemove'){
      ACTIVE_CHART=chart;
      if(tt?.getActiveElements()?.length){
        const dp=tt.dataPoints[0];
        const lab=dp.dataset.label||'';
        const val=typeof dp.raw==='number'?dp.raw.toFixed(3):dp.raw;
        TooltipEl.innerText=`${lab}: ${val}`;
        TooltipEl.style.display='block';
        TooltipEl.style.left=(e.x+12)+'px';
        TooltipEl.style.top=(e.y+12)+'px';
        const theme=getComputedStyle(document.body);
        TooltipEl.style.background=theme.getPropertyValue('--sys-surface')||'rgba(20,24,35,.6)';
        TooltipEl.style.color=theme.getPropertyValue('--sys-on-bg')||'#e5e7eb';
      }else{
        TooltipEl.style.display='none';
      }
    }else if(e.type==='mouseout'){
      if(ACTIVE_CHART===chart) ACTIVE_CHART=null;
      TooltipEl.style.display='none';
    }
  }
};

const FocusBlurPlugin={
  id:'focusBlur',
  beforeDatasetsDraw(chart){
    if(ACTIVE_CHART!==chart) return;
    const tt=chart.tooltip;
    if(!tt?.getActiveElements()?.length) return;
    const dp=tt.dataPoints[0];
    const meta=chart.getDatasetMeta(dp.datasetIndex);
    if(!meta?.data?.length) return;
    const x=dp.element.x;
    const ctx=chart.ctx, area=chart.chartArea;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.right-area.left, area.bottom-area.top);
    ctx.save();
    ctx.globalCompositeOperation='destination-out';
    ctx.rect(x-18, area.top, 36, area.bottom-area.top);
    ctx.fill();
    ctx.restore();
    ctx.clip();
    const points=meta.data;
    ctx.filter='blur(1.2px)';
    ctx.globalAlpha=0.6;
    ctx.lineWidth=meta.dataset.borderWidth||2;
    ctx.strokeStyle=meta.dataset.borderColor;
    ctx.beginPath();
    for(let i=0;i<points.length;i++){
      const p=points[i];
      if(!p||p.x==null||p.y==null) continue;
      if(i===0) ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y);
    }
    ctx.stroke();
    ctx.restore();
  }
};

if(window.Chart){try{Chart.register(CrosshairPlugin, FocusBlurPlugin);}catch(_){}}

function makeLineChart(canvas,label,min,max){
  const ctx=canvas.getContext('2d');
  const stroke=gradientStroke(ctx,'#7ab8ff','#5e8bff');
  const fill=gradientFill(ctx,'rgba(94,139,255,.25)');
  const chart=new Chart(ctx,{
    type:'line',
    data:{labels:[],datasets:[{label:label,data:[],fill:true,backgroundColor:fill,borderColor:stroke,tension:.25,pointRadius:0,borderWidth:2}]},
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:{enabled:true}},
      scales:{y:{min:min,max:max,grid:{color:'rgba(148,163,184,.15)'}},x:{grid:{display:false}}}
    }
  });
  const resize=()=>chart.resize();
  window.addEventListener('resize',resize);
  return {update:(val)=>push1(chart,val),resize};
}

function makeDualLineChart(canvas,l1,l2){
  const ctx=canvas.getContext('2d');
  const s1=gradientStroke(ctx,'#8be3ff','#6fb7ff');
  const f1=gradientFill(ctx,'rgba(111,183,255,.18)');
  const s2=gradientStroke(ctx,'#b2c8ff','#8aa7ff');
  const chart=new Chart(ctx,{
    type:'line',
    data:{labels:[],datasets:[
      {label:l1,data:[],fill:true,backgroundColor:f1,borderColor:s1,tension:.25,pointRadius:0,borderWidth:2},
      {label:l2,data:[],fill:false,borderColor:s2,tension:.25,pointRadius:0,borderWidth:2}
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,animation:false,
      interaction:{mode:'index',intersect:false},
      plugins:{legend:{labels:{color:'#aebbd1'}},tooltip:{enabled:true}},
      scales:{y:{beginAtZero:true,grid:{color:'rgba(148,163,184,.15)'}},x:{grid:{display:false}}}
    }
  });
  const resize=()=>chart.resize();
  window.addEventListener('resize',resize);
  return {update:(u,d)=>push2(chart,u,d),resize};
}

function push1(chart,v){
  const now=new Date().toLocaleTimeString();
  chart.data.labels.push(now);
  chart.data.datasets[0].data.push(v);
  if(chart.data.labels.length>MAX_POINTS){chart.data.labels.shift();chart.data.datasets[0].data.shift();}
  chart.update('none');
}

function push2(chart,a,b){
  const now=new Date().toLocaleTimeString();
  chart.data.labels.push(now);
  chart.data.datasets[0].data.push(a);
  chart.data.datasets[1].data.push(b);
  if(chart.data.labels.length>MAX_POINTS){chart.data.labels.shift();chart.data.datasets[0].data.shift();chart.data.datasets[1].data.shift();}
  chart.update('none');
}

function renderProcs(list){
  const tb=document.querySelector('#procTable tbody'); if(!tb) return;
  tb.innerHTML='';
  list.forEach(p=>{const tr=document.createElement('tr');tr.innerHTML=`<td>${p.pid}</td><td>${p.name||''}</td><td>${p.cpu.toFixed(1)}</td><td>${p.mem.toFixed(1)}</td>`;tb.appendChild(tr);});
}

function widgetFactory(id){
  if(id==='card_cpu')   return {mount:(node)=>makeLineChart(node.querySelector('canvas'),'CPU %',0,100)};
  if(id==='card_ram')   return {mount:(node)=>makeLineChart(node.querySelector('canvas'),'RAM %',0,100)};
  if(id==='card_net')   return {mount:(node)=>makeDualLineChart(node.querySelector('canvas'),'Up','Down')};
  if(id==='card_procs') return {mount:()=>({update:(d)=>renderProcs(d)})};
  const plug=(window.PLUGIN_WIDGETS||[]).find(w=>w.id===id);
  if(plug&&typeof plug.mount==='function') return {mount:plug.mount};
  return {mount:()=>({update:()=>{}})};
}
window.widgetFactory = widgetFactory;

function buildGrid(layout){
  const gridEl=document.getElementById('grid');
  GRID=GridStack.init({column:12,cellHeight:70,margin:8,animate:true,staticGrid:!EDIT,handle:'.drag-handle'},gridEl);
  const core=buildCoreDefs();
  const pluginDefs=(window.PLUGIN_WIDGETS||[]).map(w=>({id:w.id,title:w.title||w.id,html:w.html||'<div></div>',minW:w.minW||2,minH:w.minH||2}));
  const defs=[...core,...pluginDefs];
  const map=Object.fromEntries(defs.map(d=>[d.id,d]));
  layout = layout.map(i=>{const d=map[i.id]||{};return {...i,w:Math.max(i.w||d.minW||4,d.minW||1),h:Math.max(i.h||d.minH||3,d.minH||1)};});
  layout.forEach(item=>{
    const def=map[item.id]; if(!def) return;
    const w=el('div');
    const c=card(def.title,def.html);
    c.classList.add('grid-stack-item-content');
    w.appendChild(c);
    GRID.addWidget(w,{x:item.x,y:item.y,w:item.w,h:item.h,minW:def.minW,minH:def.minH,id:item.id});
  });
  GRID.engine.nodes.forEach(n=>{const inst=window.widgetFactory(n.id).mount(n.el.querySelector('.card'));n._widgetInst=inst;});
  GRID.on('resizestop',()=>{GRID.engine.nodes.forEach(n=>{if(n._widgetInst&&n._widgetInst.resize)n._widgetInst.resize();});});
  setTimeout(()=>{GRID.engine.nodes.forEach(n=>{if(n._widgetInst&&n._widgetInst.resize)n._widgetInst.resize();});},0);
}

function serializeLayout(){return GRID.engine.nodes.map(n=>({id:n.id,x:n.x,y:n.y,w:n.w,h:n.h}));}

async function preloadHistory(){
  const hist = await api('/api/metrics?hours=6&step=10').catch(()=>[]);
  const nodes = GRID?.engine?.nodes||[];
  hist.forEach(s=>{
    nodes.forEach(n=>{
      const w=n._widgetInst; if(!w||!w.update) return;
      if(n.id==='card_cpu' && s.cpu!=null) w.update(s.cpu);
      else if(n.id==='card_ram' && s.ram!=null) w.update(s.ram);
      else if(n.id==='card_net' && s.up!=null && s.down!=null) w.update(s.up, s.down);
    });
  });
}

async function tick(){
  try{
    const s=await api('/api/stats');
    const c=document.getElementById('cpu-total'); if(c) c.textContent=s.cpu.total.toFixed(0);
    const r=document.getElementById('ram-percent'); if(r) r.textContent=s.ram.percent.toFixed(0);
    const u=document.getElementById('net-up'); if(u) u.textContent=s.net.up_mbps.toFixed(2);
    const d=document.getElementById('net-down'); if(d) d.textContent=s.net.down_mbps.toFixed(2);
    const di=document.getElementById('disk-percent'); if(di) di.textContent=s.disk.percent.toFixed(0);
    const t=document.getElementById('temp'); if(t) t.textContent=s.temperature_c==null?'–':s.temperature_c.toFixed(1);
    const procs=await api('/api/processes?top=5');
    GRID.engine.nodes.forEach(n=>{
      const w=n._widgetInst; if(!w||!w.update) return;
      if(n.id==='card_cpu') w.update(s.cpu.total);
      else if(n.id==='card_ram') w.update(s.ram.percent);
      else if(n.id==='card_net') w.update(s.net.up_mbps,s.net.down_mbps);
      else if(n.id==='card_procs') w.update(procs);
      else w.update(s,procs);
    });
  }catch(e){console.error(e);}
}

function bindUI(){
  const btnEdit=document.getElementById('editToggle');
  const btnSave=document.getElementById('saveLayout');
  const selPreset=document.getElementById('presetSelect');
  const btnSavePreset=document.getElementById('savePreset');
  const btnDelPreset=document.getElementById('deletePreset');
  btnEdit.addEventListener('click',()=>{
    EDIT=!EDIT;
    document.body.classList.toggle('editable',EDIT);
    GRID.setStatic(!EDIT);
    btnEdit.textContent=EDIT?'Done':'Edit';
  });
  btnSave.addEventListener('click',async()=>{await saveLayout(serializeLayout());});
  btnSavePreset.addEventListener('click',async()=>{
    const name=prompt('Preset name'); if(!name) return;
    await savePreset(name, serializeLayout());
    PRESETS=await getPresets();
    renderPresets(selPreset, PRESETS);
  });
  btnDelPreset.addEventListener('click',async()=>{
    const id=selPreset.value; if(!id) return;
    await deletePreset(id);
    PRESETS=await getPresets();
    renderPresets(selPreset, PRESETS);
  });
  selPreset.addEventListener('change',()=>{
    const id=selPreset.value; if(!id) return;
    const p=PRESETS.find(x=>String(x.id)===String(id)); if(!p) return;
    GRID.destroy(false);
    buildGrid(p.layout);
  });
}

function renderPresets(select, presets){
  select.innerHTML='<option value="">Presets</option>'+presets.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
}

async function boot(){
  const layout=await getLayout();
  buildGrid(layout);
  await preloadHistory();
  PRESETS=await getPresets().catch(()=>[]);
  renderPresets(document.getElementById('presetSelect'), PRESETS);
  bindUI();
  setInterval(tick, INTERVAL_MS);
  tick();
}

window.PLUGIN_WIDGETS=window.PLUGIN_WIDGETS||[];
boot();
