/* Local image-to-wall workbench. Deliberately returns candidates, not structural classifications. */
(() => {
  'use strict';
  let dialog, canvas, ctx, viewport, apply;
  let src = null, original = null, walls = [], points = [], drag = null;
  let mode = 'inspect', scale = 20, calibrated = false, sourceName = '', selected = -1;
  let history = [], future = [], dirty = false, busy = false, loadTicket = 0, editFrame = null;
  const $ = id => dialog.querySelector('#' + id);
  const clone = value => JSON.parse(JSON.stringify(value));
  const number = (id, min, max) => {
    const n = Number($(id).value);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`请输入 ${min}–${max} 范围内的有效数值。`);
    return n;
  };
  const setStatus = (text, error = false) => { $('wiStatus').textContent = text; $('wiStatus').dataset.error = error; };
  function createCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function imageCanvas(image) {
    const r = Math.min(1, 2200 / Math.max(image.width, image.height));
    const c = createCanvas(Math.max(1, Math.round(image.width*r)), Math.max(1, Math.round(image.height*r)));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0,0,c.width,c.height); g.drawImage(image,0,0,c.width,c.height);
    return c;
  }
  function build() {
    dialog = document.createElement('dialog'); dialog.id = 'wallImport'; dialog.setAttribute('aria-labelledby','wiTitle');
    dialog.innerHTML = `<div class="wi-shell">
      <header class="wi-head"><div><h2 id="wiTitle">户型图 → 墙体模型</h2><div class="wi-sub">本地处理 · 支持不同户型 · 识别结果可校正</div></div><button id="wiClose" aria-label="关闭户型导入">关闭</button></header>
      <div class="wi-body"><aside class="wi-controls">
        <fieldset><legend>01 / 选择户型</legend><label for="wiFile">上传 PNG / JPG / WebP<input id="wiFile" type="file" accept="image/png,image/jpeg,image/webp"></label>
        <p class="wi-note">宣传单先框选主户型；一张图里有多户时，可只选其中一户。裁剪后需重新识别和标定。</p>
        <div class="wi-row"><button id="wiCrop" data-mode="crop">框选范围</button><button id="wiOriginal">恢复原图</button></div></fieldset>
        <fieldset><legend>02 / 提取墙体候选</legend>
        <label>识别方式<select id="wiDetectMode"><option value="solid">实心深色墙（彩色 / 简图）</option><option value="outline">双线墙（线稿，实验性）</option></select></label>
        <label>深色阈值 <output id="wiThresholdValue">110</output><input id="wiThreshold" type="range" min="30" max="210" value="110"></label>
        <div class="wi-row"><label>最小墙厚（像素）<input id="wiMinThickness" type="number" min="2" max="50" value="4"></label><label>最短墙段（像素）<input id="wiMinLength" type="number" min="8" max="300" value="30"></label></div>
        <button id="wiDetect" class="wi-primary">识别墙体</button>
        <p class="wi-note">根据深色长条或双线提取，家具可能误入，浅色墙可能漏掉。橙色框仅代表候选；门窗开口需人工检查。</p></fieldset>
        <fieldset><legend>03 / 校正与尺寸</legend>
        <label>补画墙厚（像素）<input id="wiBrush" type="number" min="2" max="80" value="8"></label>
        <p class="wi-note">补墙：沿墙拖动，自动横竖对齐。擦除：框选误识别区域，也可切出门窗开口。点选墙后按 Delete 删除整段。</p>
        <button id="wiCalibrate" data-mode="calibrate">标定：依次点两个尺寸端点</button>
        <label>这两点实际距离（mm）<input id="wiDistance" type="number" min="100" max="100000" placeholder="例如 3600"></label>
        <button id="wiSetScale">应用尺寸</button>
        <label>墙高（mm）<input id="wiHeight" type="number" min="1800" max="10000" step="100" value="2800"></label>
        <div class="wi-stat" id="wiStats">尚未上传户型图</div>
        <label><input id="wiApprox" type="checkbox"> 无尺寸时允许生成暂估比例预览</label></fieldset>
      </aside><section class="wi-work">
        <div class="wi-tools"><button data-mode="inspect" aria-pressed="true">点选</button><button data-mode="draw">补墙</button><button data-mode="erase">擦除 / 开口</button><button id="wiDelete">删除选中</button><button id="wiUndo">撤销</button><button id="wiRedo">重做</button>
        <label>缩放<input id="wiZoom" aria-label="底图缩放" type="range" min="1" max="4" step=".25" value="1"></label></div>
        <div class="wi-viewport" id="wiViewport"><div class="wi-canvas-wrap"><canvas id="wiCanvas" width="1" height="1" aria-label="墙体识别与校正画布" tabindex="0"></canvas></div><div class="wi-empty" id="wiEmpty">上传一张户型图<br>框选范围 → 识别 → 校正 → 生成</div></div>
        <div id="wiStatus" class="wi-status" role="status" aria-live="polite">图片在浏览器内处理，不上传服务器。</div>
      </section></div>
      <footer class="wi-foot"><span>仅建立墙体与参考地面。承重性质未知；不会自动布置家具。<br id="wiFooterBreak"><span id="wiApplyHint">新图会替换当前方案，可在主界面撤销恢复。</span></span><button id="wiApply" class="wi-primary" disabled>应用墙体模型</button></footer>
    </div>`;
    document.body.append(dialog); canvas = $('wiCanvas'); ctx = canvas.getContext('2d'); viewport = $('wiViewport');
    $('wiClose').onclick = close;
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    // Prevent the host app's Delete/Ctrl-Z/space shortcuts from acting behind the modal.
    dialog.addEventListener('keydown', e => {
      e.stopPropagation();
      if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey); }
    });
    $('wiFile').onchange = e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; };
    dialog.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    $('wiThreshold').oninput = () => { $('wiThresholdValue').textContent = $('wiThreshold').value; };
    $('wiDetect').onclick = detect;
    $('wiSetScale').onclick = () => {
      try {
        if (points.length !== 2) throw new Error('先点“标定”，在原图上依次点击已知尺寸的两个端点。');
        const mm = number('wiDistance',100,100000), px = Math.hypot(points[1].x-points[0].x,points[1].y-points[0].y);
        if (px < 8) throw new Error('两点太近，请选择更长的已知尺寸。');
        const nextScale = mm / px;
        if (src.width*nextScale>100000 || src.height*nextScale>100000) throw new Error('标定后范围超过 100 米，请检查端点和毫米单位。');
        push(); scale = nextScale; calibrated = true; dirty = true;
        setStatus(`已标定：${Math.round(px)} 像素 = ${mm} mm。请检查墙体后应用。`); refresh();
      } catch (err) { setStatus(err.message,true); }
    };
    $('wiOriginal').onclick = () => {
      if (!original || busy) return;
      if (dirty && !confirm('恢复原图会清除当前墙体和尺寸标定，继续？')) return;
      src = imageCanvas(original); editFrame = null; resetGeometry(); dirty = true; fit(); refresh();
      setStatus('已恢复整张原图，请框选要识别的户型。');
    };
    $('wiUndo').onclick = () => undo(false); $('wiRedo').onclick = () => undo(true);
    $('wiDelete').onclick = deleteSelected;
    $('wiZoom').oninput = fit; $('wiApprox').onchange = refresh;
    $('wiHeight').oninput = () => { dirty = true; };
    $('wiApply').onclick = applyPlan;
    canvas.addEventListener('pointerdown', pointerDown); canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp); canvas.addEventListener('pointercancel', () => { drag = null; render(); });
    new ResizeObserver(() => { if (dialog.open) fit(); }).observe(viewport);
  }
  function close() {
    if (busy) return;
    if (dirty && !confirm('关闭并放弃尚未应用的墙体修改？')) return;
    ++loadTicket; dialog.close();
  }
  function setMode(next) {
    mode = next; selected = -1;
    if (next === 'calibrate') points = [];
    dialog.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.mode===next)));
    const hints = {inspect:'点击橙色候选框可选中墙段，按 Delete 删除。',crop:'拖出矩形范围。裁剪会清除当前识别及尺寸标定。',draw:'沿墙中心拖动，自动吸附水平或竖直方向。',erase:'拖出矩形，擦除其中的墙体；可用来留出门窗开口。',calibrate:'依次点两个已知尺寸端点，再输入实际长度（mm）并应用尺寸。'};
    setStatus(hints[next]); render();
  }
  function resetGeometry() { walls=[]; points=[]; selected=-1; scale=20; calibrated=false; history=[]; future=[]; $('wiApprox').checked=false; }
  function state() { return {walls:clone(walls),points:clone(points),scale,calibrated}; }
  function push() { history.push(state()); if(history.length>60)history.shift(); future=[]; }
  function undo(redo) {
    if (busy) return;
    const from=redo?future:history, to=redo?history:future;
    if(!from.length)return;
    to.push(state()); const s=from.pop(); walls=s.walls; points=s.points; scale=s.scale; calibrated=s.calibrated; selected=-1; dirty=true; refresh();
  }
  function deleteSelected() { if(selected<0 || busy)return; push(); walls.splice(selected,1); selected=-1; dirty=true; refresh(); }
  function refresh() {
    $('wiEmpty').hidden=!!src; canvas.hidden=!src;
    $('wiApply').disabled=busy || !walls.length || (!calibrated&&!$('wiApprox').checked);
    $('wiDetect').disabled=busy||!src; $('wiUndo').disabled=busy||!history.length; $('wiRedo').disabled=busy||!future.length;
    $('wiDelete').disabled=selected<0; $('wiFile').disabled=busy;
    $('wiApplyHint').textContent=editFrame&&Math.abs(editFrame.scale-scale)<1e-8?'编辑墙体保留已有家具和测量，可在主界面撤销恢复。':'新图、裁剪或更改比例会清空原有布置，可在主界面撤销恢复。';
    $('wiStats').textContent=src?`${walls.length} 段墙体 · ${src.width} × ${src.height} px\n${calibrated?`已标定 · ${(scale).toFixed(2)} mm/px`:'未标定 · 当前仅为暂估比例'}`:'尚未上传户型图';
    $('wiStats').style.whiteSpace='pre-line'; render();
  }
  function fit() {
    if(!src)return;
    const base=Math.min((viewport.clientWidth-38)/src.width,(viewport.clientHeight-38)/src.height);
    const factor=Math.max(.03,base)*Number($('wiZoom').value);
    canvas.style.width=`${Math.round(src.width*factor)}px`;canvas.style.height=`${Math.round(src.height*factor)}px`;
  }
  function render() {
    if(!src)return;
    if(canvas.width!==src.width||canvas.height!==src.height) { canvas.width=src.width;canvas.height=src.height; }
    ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(src,0,0);
    const unit=src.width/Math.max(1,canvas.clientWidth);
    walls.forEach((w,i)=>{ctx.fillStyle=i===selected?'#087a6b88':'#ff882d66';ctx.strokeStyle=i===selected?'#00564a':'#e66416';ctx.lineWidth=unit;ctx.fillRect(w[0],w[1],w[2]-w[0],w[3]-w[1]);ctx.strokeRect(w[0],w[1],w[2]-w[0],w[3]-w[1]);});
    ctx.strokeStyle='#0577c6';ctx.fillStyle='#0577c6';ctx.lineWidth=2*unit;
    if(points.length){ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);points.forEach(p=>ctx.lineTo(p.x,p.y));ctx.stroke();points.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,4*unit,0,Math.PI*2);ctx.fill();});}
    if(drag){
      const r=mode==='draw'?lineRect(drag.a,drag.b):rect(drag.a,drag.b);
      ctx.fillStyle=mode==='erase'?'#de3f3f44':'#178ab344';ctx.fillRect(r[0],r[1],r[2]-r[0],r[3]-r[1]);ctx.strokeStyle=mode==='erase'?'#c32828':'#087ab2';ctx.strokeRect(r[0],r[1],r[2]-r[0],r[3]-r[1]);
    }
  }
  function point(e){const r=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(src.width,(e.clientX-r.left)*src.width/r.width)),y:Math.max(0,Math.min(src.height,(e.clientY-r.top)*src.height/r.height))};}
  function rect(a,b){return[Math.min(a.x,b.x),Math.min(a.y,b.y),Math.max(a.x,b.x),Math.max(a.y,b.y)];}
  function lineRect(a,b){
    const raw=Number($('wiBrush').value);const thick=Math.max(2,Math.min(80,Number.isFinite(raw)?raw:8));
    const horizontal=Math.abs(b.x-a.x)>=Math.abs(b.y-a.y);
    return horizontal?[Math.min(a.x,b.x),Math.max(0,a.y-thick/2),Math.max(a.x,b.x),Math.min(src.height,a.y+thick/2)]:[Math.max(0,a.x-thick/2),Math.min(a.y,b.y),Math.min(src.width,a.x+thick/2),Math.max(a.y,b.y)];
  }
  function pointerDown(e){
    if(!src||busy||e.button!==0)return;e.preventDefault();canvas.focus();const p=point(e);
    if(mode==='calibrate'){if(points.length===2)points=[];points.push(p);render();if(points.length===2)setStatus('已选两个端点。输入两点实际距离，再点“应用尺寸”。');return;}
    if(mode==='inspect'){
      selected=-1;for(let i=walls.length-1;i>=0;i--){const w=walls[i];if(p.x>=w[0]&&p.x<=w[2]&&p.y>=w[1]&&p.y<=w[3]){selected=i;break;}}refresh();return;
    }
    drag={a:p,b:p,id:e.pointerId};canvas.setPointerCapture(e.pointerId);render();
  }
  function pointerMove(e){if(!drag||drag.id!==e.pointerId)return;drag.b=point(e);render();}
  function pointerUp(e){
    if(!drag||drag.id!==e.pointerId)return;drag.b=point(e);const d=drag;drag=null;
    if(Math.hypot(d.a.x-d.b.x,d.a.y-d.b.y)<3){render();return;}
    const r=rect(d.a,d.b);
    if(mode==='crop'){
      if(r[2]-r[0]<30||r[3]-r[1]<30){setStatus('选区太小，请至少保留 30 × 30 像素。',true);render();return;}
      if(walls.length&&!confirm('裁剪会清除当前墙体和标定，继续？')){render();return;}
      const c=createCanvas(Math.round(r[2]-r[0]),Math.round(r[3]-r[1]));c.getContext('2d').drawImage(src,r[0],r[1],r[2]-r[0],r[3]-r[1],0,0,c.width,c.height);
      src=c;editFrame=null;resetGeometry();dirty=true;$('wiZoom').value=1;
      $('wiMinThickness').value=Math.max(3,Math.round(Math.max(src.width,src.height)*.003));
      $('wiMinLength').value=Math.max(18,Math.round(Math.max(src.width,src.height)*.028));
      setMode('inspect');fit();setStatus('已裁剪。请识别墙体；尺寸标定应在当前裁剪图上进行。');
    }else if(mode==='draw'){
      if(walls.length>=3000){setStatus('墙段过多，请先删除不需要的候选。',true);render();return;}
      push();walls.push([...lineRect(d.a,d.b),'u']);dirty=true;
    }else if(mode==='erase'){
      push();walls=walls.flatMap(w=>subtract(w,r));selected=-1;dirty=true;
    }refresh();
  }
  // Rectangle subtraction preserves the portions outside an eraser, including door jambs.
  function subtract(w,r){
    const x0=Math.max(w[0],r[0]),y0=Math.max(w[1],r[1]),x1=Math.min(w[2],r[2]),y1=Math.min(w[3],r[3]);
    if(x1<=x0||y1<=y0)return[w];
    return[[w[0],w[1],w[2],y0,'u'],[w[0],y1,w[2],w[3],'u'],[w[0],y0,x0,y1,'u'],[x1,y0,w[2],y1,'u']].filter(a=>a[2]-a[0]>=1&&a[3]-a[1]>=1);
  }
  async function loadFile(file){
    if(busy)return;
    if(!/^image\/(png|jpeg|webp)$/.test(file.type)){setStatus('请选择 PNG、JPG 或 WebP 图片。',true);return;}
    if(file.size>20*1024*1024){setStatus('图片超过 20 MB，请先压缩。',true);return;}
    if(dirty&&!confirm('上传新图会放弃尚未应用的编辑，继续？'))return;
    const ticket=++loadTicket;const url=URL.createObjectURL(file);busy=true;refresh();setStatus('正在读取图片…');
    try{
      const image=new Image();image.src=url;await image.decode();
      if(ticket!==loadTicket)return;
      if(image.width*image.height>40e6)throw new Error('图片像素过大，请缩小到 4000 万像素以内。');
      src=imageCanvas(image);original=imageCanvas(src);sourceName=file.name;editFrame=null;resetGeometry();dirty=false;$('wiHeight').value=2800;$('wiZoom').value=1;
      $('wiMinThickness').value=Math.max(3,Math.round(Math.max(src.width,src.height)*.003));
      $('wiMinLength').value=Math.max(18,Math.round(Math.max(src.width,src.height)*.028));
      setMode('inspect');fit();setStatus('图片已载入。宣传单或双户型图先框选范围，再点“识别墙体”。');
    }catch(err){setStatus('无法读取图片：'+err.message,true);}finally{URL.revokeObjectURL(url);busy=false;refresh();}
  }
  async function detect(){
    if(!src||busy)return;
    if(walls.length&&!confirm('重新识别会替换当前墙体，可用编辑器撤销恢复，继续？'))return;
    try{
      const threshold=number('wiThreshold',30,210),minThickness=number('wiMinThickness',2,50),minLength=number('wiMinLength',8,300);
      if(!window.WallDetector)throw new Error('识别组件未加载，请刷新页面。');
      busy=true;refresh();setStatus('正在提取墙体候选…');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const r=Math.min(1,1400/Math.max(src.width,src.height));
      const c=createCanvas(Math.round(src.width*r),Math.round(src.height*r));const g=c.getContext('2d');g.drawImage(src,0,0,c.width,c.height);
      const result=window.WallDetector.detect(g.getImageData(0,0,c.width,c.height),{threshold,minThickness:Math.max(2,Math.round(minThickness*r)),minLength:Math.max(8,Math.round(minLength*r)),maxThickness:Math.max(12,Math.round(minThickness*5*r)),mode:$('wiDetectMode').value});
      const rx=c.width/src.width,ry=c.height/src.height;
      push();walls=result.walls.map(w=>[Math.max(0,w[0]/rx),Math.max(0,w[1]/ry),Math.min(src.width,w[2]/rx),Math.min(src.height,w[3]/ry),'u']);selected=-1;dirty=true;
      setStatus(walls.length?`提取到 ${walls.length} 段候选。请检查橙色覆盖，删除家具误检、补足漏墙并保留开口。${result.warnings?.length?'\n'+result.warnings.join('；'):''}`:'未找到墙体。可调高深色阈值、降低墙厚，或切换双线方式；也可手动补墙。',!walls.length);
    }catch(err){setStatus('识别失败：'+err.message,true);}finally{busy=false;refresh();}
  }
  async function applyPlan(){
    try{
      if(!src||!walls.length)throw new Error('请先识别或补画墙体。');
      if(!calibrated&&!$('wiApprox').checked)throw new Error('请标定尺寸，或明确选择暂估比例预览。');
      const height=number('wiHeight',1800,10000);
      const plan={version:1,name:sourceName||'导入户型',walls:walls.map(w=>[...w.slice(0,4).map(n=>Math.round(n*scale*100)/100),'u']),bounds:{x:0,y:0,w:src.width*scale,h:src.height*scale},height,calibrated,editor:{image:src.toDataURL('image/jpeg',.82),width:src.width,height:src.height,mmPerPixel:scale}};
      const preserveLayout=!!editFrame&&Math.abs(editFrame.scale-scale)<1e-8;
      if(preserveLayout){
        plan.bounds={...editFrame.bounds};plan.walls=plan.walls.map(w=>[w[0]+plan.bounds.x,w[1]+plan.bounds.y,w[2]+plan.bounds.x,w[3]+plan.bounds.y,'u']);
        if(!editFrame.hasImage)delete plan.editor;
      }
      await apply(plan,{preserveLayout});dirty=false;dialog.close();
    }catch(err){setStatus('无法应用：'+err.message,true);}
  }
  async function open(options={}){
    if(!dialog)build();apply=options.onApply||window.loadCustomWalls;
    if(dialog.open)return;
    resetGeometry();src=null;original=null;sourceName='';editFrame=null;dirty=false;busy=false;$('wiZoom').value=1;$('wiHeight').value=2800;setMode('inspect');refresh();dialog.showModal();
    const plan=options.plan;
    if(plan){
      try{
        busy=true;refresh();
        scale=plan.editor?.mmPerPixel||20;calibrated=!!plan.calibrated;sourceName=plan.name||'导入户型';$('wiHeight').value=plan.height||2800;
        if(plan.editor?.image){
          const img=new Image();img.src=plan.editor.image;await img.decode();
          if(img.width!==plan.editor.width||img.height!==plan.editor.height)throw new Error('底图实际尺寸与记录不一致。');
          src=imageCanvas(img);
        }
        else{const factor=Math.min(1,1800/Math.max(plan.bounds.w/scale,plan.bounds.h/scale));scale/=factor;src=createCanvas(Math.max(1,Math.round(plan.bounds.w/scale)),Math.max(1,Math.round(plan.bounds.h/scale)));const g=src.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,src.width,src.height);}
        editFrame={scale,bounds:{...plan.bounds},hasImage:!!plan.editor};original=imageCanvas(src);walls=plan.walls.map(w=>[(w[0]-plan.bounds.x)/scale,(w[1]-plan.bounds.y)/scale,(w[2]-plan.bounds.x)/scale,(w[3]-plan.bounds.y)/scale,'u']);
        $('wiApprox').checked=!calibrated;fit();setStatus('已恢复当前墙体。可以继续补删墙或上传另一张图。');
      }catch(err){src=null;original=null;resetGeometry();setStatus('无法恢复编辑底图，请重新上传。'+err.message,true);}finally{busy=false;refresh();}
    }else setStatus('图片在浏览器内处理。上传后先选定要识别的户型范围。');
  }
  window.WallImport={open};
})();
