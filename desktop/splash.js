// desktop/splash.js — la ventana de ARRANQUE de Cartera (rediseño v4, diseño de Control TC v7 aprobado
// por el PO). La usa desktop/main.js durante el arranque protegido (FASE 2 a 4): se dibuja ANTES de
// conectar la base de datos, con un HTML propio en una data: URL.
//
//   buildSplashHtml(tema, { fuente, version })
//     tema     'dark' | 'light' (el que la app dejo en userData/apariencia.json; ver main.js)
//     fuente   Inter en base64 (la data: URL no puede pedir archivos); sin ella, la del sistema
//     version  el texto de abajo ("Versión 3.7.1")
//
// Cuatro vistas, las mismas de Control TC: vLoading (buscar, descargar, instalar, abrir los datos),
// vOffline (sin conexion), vUpdateError (fallo la descarga) y vFatal (la app no pudo iniciar: reemplaza
// al cuadro nativo de Windows "Error de arranque"). Los botones avisan a main.js por IPC:
// 'splash-decision' ('continue' | 'quit') y 'splash-fatal' ('copiar' | 'cerrar').
//
// Las funciones js* devuelven el codigo que main.js ejecuta en la ventana (executeJavaScript) para
// cambiar textos y vistas. Viven aqui, junto a los ids que tocan, y los textos viajan con
// JSON.stringify: comillas, barras y saltos de linea llegan intactos (tests/arranque.js las corre).

const PALETAS = {
  dark: { bg: '#000000', surface2: '#111111', surface3: '#191919', line: 'rgba(255,255,255,0.08)', lineStrong: 'rgba(255,255,255,0.16)',
    text: '#f5f5f4', text2: '#a3a3a0', text3: '#858580', inverseBg: '#f5f5f4', inverseText: '#0a0a0a', accent: '#5b9bf0', track: 'rgba(255,255,255,0.08)', crit: '#d03b3b' },
  light: { bg: '#f6f6f3', surface2: '#fbfbf9', surface3: '#ecece8', line: 'rgba(10,10,10,0.07)', lineStrong: 'rgba(10,10,10,0.16)',
    text: '#0a0a0a', text2: '#4b4b47', text3: '#6b6b66', inverseBg: '#0a0a0a', inverseText: '#fafafa', accent: '#2a6fd1', track: 'rgba(10,10,10,0.07)', crit: '#d03b3b' },
};

// Los mismos trazos de public/js/componentes/iconos.js.
const ICO = {
  briefcase: 'M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2',
  wifi: 'M1 1l22 22 M16.72 11.06A10.94 10.94 0 0119 12.55 M5 12.55a10.94 10.94 0 015.17-2.39 M10.71 5.05A16 16 0 0122.58 9 M1.42 9a15.91 15.91 0 014.7-2.88 M8.53 16.11a6 6 0 016.95 0 M12 20h.01',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  alert: 'M12 9v4 M12 17h.01 M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  right: 'M9 18l6-6-6-6',
};
const ico = (n, s, sw) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw || 1.8}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICO[n]}"/></svg>`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildSplashHtml(tema, opts) {
  const o = opts || {};
  const c = PALETAS[tema] || PALETAS.dark;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><style>
${o.fuente ? `@font-face{font-family:'Inter';font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${o.fuente}) format('woff2');}` : ''}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{width:100%;height:100%;overflow:hidden;font-family:'Inter','Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,sans-serif;font-feature-settings:'cv11','ss01';background:${c.bg};color:${c.text};-webkit-user-select:none;user-select:none;-webkit-font-smoothing:antialiased;}
body{position:relative;border:1px solid ${c.lineStrong};-webkit-app-region:drag;}
button,summary,#fatalDetail{-webkit-app-region:no-drag;}
#vLoading,#vOffline,#vUpdateError,#vFatal{position:absolute;inset:0;flex-direction:column;animation:vista .32s cubic-bezier(.2,.7,.2,1) both;}
#vLoading{display:flex;}
#vOffline,#vUpdateError,#vFatal{display:none;}
@keyframes vista{from{opacity:0;transform:translateY(5px);}to{opacity:1;transform:none;}}
.centro{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 32px 0;text-align:center;}
.marca{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;background:${c.inverseBg};color:${c.inverseText};}
.nombre{margin-top:14px;font-size:17px;font-weight:600;letter-spacing:-0.015em;}
#splashMsg{margin-top:6px;font-size:13px;color:${c.text2};min-height:18px;}
.barra{position:relative;width:200px;height:3px;border-radius:2px;background:${c.track};overflow:hidden;}
#barIndet{margin-top:18px;}
#barIndet i{position:absolute;top:0;bottom:0;left:-35%;width:35%;border-radius:2px;background:${c.text2};animation:barra 1.5s cubic-bezier(.2,.7,.2,1) infinite;}
@keyframes barra{to{left:100%;}}
#barWrap{display:none;align-items:center;gap:10px;margin-top:18px;}
#barWrap.show{display:flex;}
#splashBar{position:absolute;top:0;bottom:0;left:0;width:0%;border-radius:2px;background:${c.text2};transition:width .2s ease;}
#splashPct{font-size:12px;color:${c.text3};font-variant-numeric:tabular-nums;min-width:38px;text-align:right;}
#countdown{margin-top:12px;font-size:12px;color:${c.text3};min-height:16px;font-variant-numeric:tabular-nums;}
.version{padding:0 0 14px;text-align:center;font-size:11.5px;color:${c.text3};font-variant-numeric:tabular-nums;}
.problema{flex:1;display:flex;flex-direction:column;padding:26px 28px 20px;}
.ic{width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:${c.surface3};color:${c.text2};}
#vFatal .ic{color:${c.crit};}
.titulo{margin-top:14px;font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;}
.texto{margin-top:6px;font-size:12.5px;color:${c.text2};line-height:1.5;}
details{margin-top:8px;font-size:12px;color:${c.text3};}
summary{display:inline-flex;align-items:center;gap:4px;list-style:none;cursor:pointer;}
summary::-webkit-details-marker{display:none;}
summary:hover{color:${c.text2};}
summary svg{transition:transform .15s ease;}
details[open] summary svg{transform:rotate(90deg);}
.detalle{margin-top:6px;max-height:52px;overflow:auto;padding:6px 10px;border-radius:8px;background:${c.surface2};border:1px solid ${c.line};overflow-wrap:anywhere;-webkit-user-select:text;user-select:text;}
.botones{margin-top:auto;display:flex;justify-content:flex-end;gap:8px;}
button{height:34px;padding:0 14px;border-radius:10px;font:inherit;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;transition:opacity .15s,background-color .15s,border-color .15s,color .15s;}
.prim{border:0;background:${c.inverseBg};color:${c.inverseText};font-weight:600;}
.prim:hover{opacity:.88;}
.sec{border:1px solid ${c.line};background:transparent;color:${c.text2};}
.sec:hover{background:${c.surface2};color:${c.text};border-color:${c.lineStrong};}
button:focus-visible,summary:focus-visible{outline:2px solid ${c.accent};outline-offset:2px;}
@media (prefers-reduced-motion:reduce){#barIndet i{animation:none;left:0;width:40%;}#vLoading,#vOffline,#vUpdateError,#vFatal{animation:none;}}
</style></head><body>
<div id="vLoading" role="status">
<div class="centro">
<div class="marca" aria-hidden="true">${ico('briefcase', 21, 2)}</div>
<div class="nombre">Cartera</div>
<div id="splashMsg">Buscando actualizaciones</div>
<div class="barra" id="barIndet" aria-hidden="true"><i></i></div>
<div id="barWrap"><div class="barra"><div id="splashBar"></div></div><span id="splashPct">0 %</span></div>
<div id="countdown"></div>
</div>
<div class="version" id="splashVersion">${o.version ? 'Versión ' + esc(o.version) : ''}</div>
</div>
<div id="vOffline" role="alertdialog" aria-labelledby="tOffline"><div class="problema">
<div class="ic">${ico('wifi', 20)}</div>
<div class="titulo" id="tOffline">No se pudo comprobar si hay una versión nueva</div>
<p class="texto">No hay conexión o el servidor no respondió en 60 segundos. Puedes seguir con la versión instalada.</p>
<div class="botones"><button class="sec" id="btnQuit">Cerrar</button><button class="prim" id="btnContinue">Continuar</button></div>
</div></div>
<div id="vUpdateError" role="alertdialog" aria-labelledby="tUpdate"><div class="problema">
<div class="ic">${ico('download', 20)}</div>
<div class="titulo" id="tUpdate">No se pudo instalar la versión nueva</div>
<p class="texto">Lo más seguro es cerrar y volver a intentarlo. También puedes seguir con la versión actual.</p>
<details><summary>${ico('right', 12)}Detalle técnico</summary><div class="detalle" id="updateErrorDetail"></div></details>
<div class="botones"><button class="sec" id="btnContinueUpdate">Seguir con la actual</button><button class="prim" id="btnQuitUpdate">Cerrar y reintentar</button></div>
</div></div>
<div id="vFatal" role="alertdialog" aria-labelledby="tFatal"><div class="problema">
<div class="ic">${ico('alert', 20)}</div>
<div class="titulo" id="tFatal">La app no pudo iniciar</div>
<p class="texto" id="fatalMsg"></p>
<details><summary>${ico('right', 12)}Detalle técnico</summary><div class="detalle" id="fatalDetail"></div></details>
<div class="botones"><button class="sec" id="btnFatalCopy">Copiar el detalle</button><button class="prim" id="btnFatalQuit">Cerrar</button></div>
</div></div>
<script>
var ipc=require('electron').ipcRenderer;
function mostrar(id){['vLoading','vOffline','vUpdateError','vFatal'].forEach(function(v){var n=document.getElementById(v);if(n)n.style.display=(v===id?'flex':'none');});}
document.getElementById('btnContinue').addEventListener('click',function(){ipc.send('splash-decision','continue');});
document.getElementById('btnQuit').addEventListener('click',function(){ipc.send('splash-decision','quit');});
document.getElementById('btnQuitUpdate').addEventListener('click',function(){ipc.send('splash-decision','quit');});
document.getElementById('btnContinueUpdate').addEventListener('click',function(){ipc.send('splash-decision','continue');});
document.getElementById('btnFatalCopy').addEventListener('click',function(){ipc.send('splash-fatal','copiar');});
document.getElementById('btnFatalQuit').addEventListener('click',function(){ipc.send('splash-fatal','cerrar');});
</script></body></html>`;
}

// ── Lo que main.js le cambia a la ventana ──────────────────────────────────────
// La linea de estado. Con `percent` se ve la barra con su porcentaje (descarga e instalacion); sin el,
// la barra fina que avanza sola. `nota`, si viene, es la frase de abajo.
function jsMensaje(msg, percent, nota) {
  let js = `(function(){var m=document.getElementById('splashMsg');if(m)m.textContent=${JSON.stringify(String(msg || ''))};`;
  js += `var w=document.getElementById('barWrap');var i=document.getElementById('barIndet');`;
  if (typeof percent === 'number' && percent >= 0) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    js += `if(w)w.classList.add('show');if(i)i.style.display='none';`;
    js += `var bar=document.getElementById('splashBar');if(bar)bar.style.width='${p}%';`;
    js += `var pct=document.getElementById('splashPct');if(pct)pct.textContent='${p} %';`;
  } else {
    js += `if(w)w.classList.remove('show');if(i)i.style.display='';`;
  }
  if (nota !== undefined) js += `var c=document.getElementById('countdown');if(c)c.textContent=${JSON.stringify(String(nota))};`;
  return js + `})();`;
}
// La cuenta atras de la busqueda de actualizaciones, como la frase de abajo.
function notaCuenta(segundos) {
  const s = Math.max(0, Math.round(segundos));
  return s > 0 ? `Si no responde en ${s} s, podrás seguir sin conexión.` : '';
}
function jsCuenta(segundos) {
  return `(function(){var c=document.getElementById('countdown');if(c)c.textContent=${JSON.stringify(notaCuenta(segundos))};})();`;
}
// Cambia de vista (vLoading, vOffline, vUpdateError, vFatal) y, si se pide, enfoca un boton.
function jsVista(id, foco) {
  return `(function(){mostrar(${JSON.stringify(id)});${foco ? `var b=document.getElementById(${JSON.stringify(foco)});if(b)b.focus();` : ''}})();`;
}
// Pone textos sueltos por id: { tUpdate: '...', updateErrorDetail: '...' }.
function jsTextos(mapa) {
  return '(function(){' + Object.keys(mapa || {}).map((id) =>
    `var e=document.getElementById(${JSON.stringify(id)});if(e)e.textContent=${JSON.stringify(String(mapa[id] == null ? '' : mapa[id]))};`).join('') + '})();';
}

// Las frases de la ventana, en un solo lugar (main.js y las pruebas las usan).
const TEXTOS = {
  buscando: 'Buscando actualizaciones',
  abriendo: 'Abriendo tus datos',
  notaAbriendo: 'Todo en orden: la app aparece en un momento.',
  descargando: (v) => 'Descargando la versión ' + (v || 'nueva'),
  reintentando: (v) => 'Reintentando la descarga de la versión ' + (v || 'nueva'),
  instalando: (v) => 'Instalando la versión ' + (v || 'nueva'),
  notaInstalando: 'La app se reinicia sola al terminar.',
  tituloErrorUpdate: (v) => v ? 'No se pudo instalar la versión ' + v : 'No se pudo instalar la versión nueva',
};

module.exports = { buildSplashHtml, PALETAS, jsMensaje, jsCuenta, notaCuenta, jsVista, jsTextos, TEXTOS };
