// tests/pdf-nativo.js — la capa NATIVA de los documentos: HTML -> bytes de PDF (desktop/pdf.js).
//
// pdf-render verifica el HTML que emiten los generadores, pero se detiene en
// `electronAPI.printPDF`: lo que pasa despues (ventana oculta, `printToPDF`) no lo
// ejercitaba ninguna prueba. Ahi vivia el Bug #69 — la app se cerraba en macOS 27 al
// generar cualquier PDF, porque la ventana oculta se creaba en modo offscreen.
//
// Dos partes:
//   1. ESTATICA (siempre): ningun archivo de desktop/ vuelve a pedir una ventana offscreen,
//      y el handler `print-pdf` de main.js delega en desktop/pdf.js en vez de tener su
//      propia copia del render. Es la guarda del Bug #69, y la unica que vale en cualquier
//      sistema: el cierre solo se reproduce en macOS 27, esta suite corre en Windows.
//   2. REAL: genera el HTML de documentos reales (generadores de produccion + fixture), los
//      pasa por `htmlAPdf` dentro de un proceso Electron COMPLETO (no ELECTRON_RUN_AS_NODE:
//      sin app no hay ventanas) y mira el PDF que sale.
//   3. EL MARGEN DE CADA HOJA (3.6.0): los documentos van dentro de un marco cuyo thead/tfoot se
//      repite en cada hoja impresa (`RB_MARCO_*`). Antes, la hoja 2 de cualquier documento largo
//      arrancaba pegada al filo del papel. Se mide DENTRO del PDF: Electron escribe el texto como
//      `1 0 0 -1 x y Tm` en un espacio continuo entre hojas (1.056 unidades por hoja carta), asi
//      que el margen de arriba de la hoja N es `min(y) - (N-1)*1056` y el de abajo `N*1056 - max(y)`.
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron tests/pdf-nativo.js

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// Por cada hoja del PDF, la y (en el espacio continuo de Electron) del texto mas alto y del mas
// bajo. `null` si la hoja no trae texto que medir.
function alturasPorHoja(buf) {
  const s = buf.toString('latin1');
  const objs = {};
  const re = /(\d+) 0 obj([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(s)) !== null) objs[m[1]] = m[2];
  const hojas = Object.keys(objs).filter(k => /\/Type\s*\/Page[^s]/.test(objs[k])).sort((a, b) => a - b);
  return hojas.map(k => {
    const c = /\/Contents\s+(\d+)\s+0\s+R/.exec(objs[k]);
    const o = c && objs[c[1]];
    if (!o) return null;
    const i = o.indexOf('stream'), j = o.lastIndexOf('endstream');
    let datos = Buffer.from(o.slice(i + 6, j).replace(/^\r?\n/, '').replace(/\r?\n$/, ''), 'latin1');
    try { datos = zlib.inflateSync(datos); } catch (_) {}
    const ys = [...datos.toString('latin1').matchAll(/1 0 0 -1 [-\d.]+ ([-\d.]+) Tm/g)].map(x => +x[1]);
    return ys.length ? { min: Math.min(...ys), max: Math.max(...ys) } : null;
  });
}

// ── Modo APP: el proceso hijo. Imprime y devuelve un JSON por stdout. ─────────────────────
if (process.argv.includes('--app')) {
  const { app, BrowserWindow } = require('electron');
  const { htmlAPdf } = require(path.join(__dirname, '..', 'desktop', 'pdf.js'));
  const dir = process.argv[process.argv.indexOf('--app') + 1];
  // En la app real la ventana principal esta siempre abierta. Aca no hay ninguna, y sin
  // este listener Electron da la app por terminada al destruir la primera ventana oculta.
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    const out = { docs: [], error: null };
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.html')).sort()) {
      const buf = await htmlAPdf(fs.readFileSync(path.join(dir, f), 'utf8'));
      const s = buf.toString('latin1');
      out.docs.push({
        doc: f.replace('.html', ''),
        bytes: buf.length,
        cabecera: s.slice(0, 5),
        paginas: (s.match(/\/Type\s*\/Page[^s]/g) || []).length,
        cajas: [...new Set(s.match(/\/MediaBox\s*\[[^\]]*\]/g) || [])],
        alturas: alturasPorHoja(buf),
        // Las letras incrustadas, sin el prefijo de subconjunto ("AAAAAA+"), y si alguna es Type 3.
        letras: [...new Set((s.match(/\/BaseFont\s*\/[A-Za-z0-9+_-]+/g) || []).map(x => x.replace(/\/BaseFont\s*\/([A-Z]{6}\+)?/, '')))].sort(),
        type3: /\/Subtype\s*\/Type3/.test(s),
        ventanasVivas: BrowserWindow.getAllWindows().length,
      });
    }
    // Camino de error: si el documento no se puede cargar, htmlAPdf tiene que rechazar Y no
    // dejar la ventana oculta viva (su `finally`). Una surrogate suelta hace fallar
    // `encodeURIComponent` DESPUES de crear la ventana, siempre; una navegacion que aborta la
    // carga no sirve: el data: termina de cargar antes y la promesa resuelve (medido).
    try {
      await htmlAPdf('<p>x</p>\uD800');
      out.error = { rechazo: false };
    } catch (e) {
      out.error = { rechazo: true, codigo: e && e.code };
    }
    out.error.ventanasVivas = BrowserWindow.getAllWindows().length;
    process.stdout.write('@@RESULTADO@@' + JSON.stringify(out) + '@@FIN@@\n');
    app.exit(0);
  }).catch(e => { console.error(e && e.stack || e); app.exit(3); });
  return;
}

// ── Modo SUITE ──────────────────────────────────────────────────────────────────────────
const { spawnSync } = require('child_process');
const LIB = path.join(__dirname, 'lib');
const { Reporter }          = require(path.join(LIB, 'report'));
const { copiaDeProduccion } = require(path.join(LIB, 'db'));
const { cargarFrontend }    = require(path.join(LIB, 'load-frontend'));
const { REPO, WORK }        = require(path.join(LIB, 'paths'));

const R = new Reporter('pdf-nativo');
const DESKTOP = path.join(REPO, 'desktop');

// 1. Guarda estatica ------------------------------------------------------------------------
R.seccion('guarda del Bug #69: sin ventanas offscreen en desktop/');
const archivosDesktop = fs.readdirSync(DESKTOP).filter(f => f.endsWith('.js'));
R.check('desktop/ tiene main.js y pdf.js', archivosDesktop.includes('main.js') && archivosDesktop.includes('pdf.js'),
        archivosDesktop);
for (const f of archivosDesktop) {
  const src = fs.readFileSync(path.join(DESKTOP, f), 'utf8');
  // Solo codigo: pdf.js explica en comentarios por que NO usa el modo offscreen.
  const codigo = l => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
  const hits = src.split('\n').map((l, i) => ({ l, i: i + 1 })).filter(x => /offscreen\s*:/i.test(codigo(x.l)));
  R.check(`${f}: ninguna ventana con \`offscreen:\``, hits.length === 0,
          hits.map(h => `linea ${h.i}: ${h.l.trim()}`).join('\n'));
}
const main = fs.readFileSync(path.join(DESKTOP, 'main.js'), 'utf8');
const iHandler = main.indexOf("ipcMain.handle('print-pdf'");
R.check('main.js registra el handler print-pdf', iHandler !== -1);
const handler = iHandler === -1 ? '' : main.slice(iHandler, main.indexOf('\n});', iHandler));
R.check('print-pdf delega el render en desktop/pdf.js', /require\('\.\/pdf'\)\.htmlAPdf\(html\)/.test(handler), handler);
R.check('print-pdf no tiene una segunda copia del render (sin BrowserWindow ni printToPDF propios)',
        !/BrowserWindow|new BW\(|printToPDF/.test(handler), handler);

// 2. Render real ----------------------------------------------------------------------------
R.seccion('render real: HTML de documentos reales -> PDF, en un proceso Electron completo');
const Database = require(path.join(REPO, 'node_modules', 'better-sqlite3'));
const db = new Database(copiaDeProduccion('pdf-nativo'), { readonly: true });
const loans = db.prepare('SELECT * FROM loans').all();
const pays  = db.prepare('SELECT * FROM payments').all();
db.close();

const FE  = cargarFrontend({ silenciarConsola: true });
const S   = FE.simbolos, CAP = FE.captura;
const tema = t => FE.sandbox.document.documentElement.setAttribute('data-theme', t);
const L = id => loans.find(x => x.id === id);
const cuota = (id, n) => pays.find(p => p.prestamoId === id && p.cuotaN === n);
const ID = '1776205975507jkph';   // C+I COP del fixture con abono intercalado

// paginasMin: el cronograma oscuro, el reporte y el recibo general de un deudor con 3 creditos
// ocupan 2 hojas (medido); se exige >= 2 para que la prueba cubra el salto de pagina y el margen
// de la hoja 2. El cronograma es el del credito de 24 cuotas: desde 3.6.0 el margen de impresion
// es de 1,3 cm (antes 2) y el de 14 cuotas ya cabe en una hoja.
const LARGO = '1773657323435hkkb';   // C+I USD de 24 cuotas
// v4: el documento ya va con el sistema de la app (rediseño por familias, 2026-11-13; con P4
// estan los 12). Su PDF tiene que llevar SOLO la Inter que incrusta desktop/pdf.js, como fuente
// estandar (sin Type 3: esa es la firma de la Inter VARIABLE, que hacia el PDF de 2,5 a 3,9
// veces mas pesado). `letrasExtra`: las letras del sistema que un documento tiene permitidas —
// los glifos ↳ y ■ del reporte no estan en los subconjuntos de Inter y salen de Segoe UI
// Symbol (el reporte VIEJO ya los incrustaba de letra del sistema, y encima en Type 3, de
// CambriaMath; por eso el check de Type 3 aplica entero tambien ahi). Un caso con `v4: false`
// (ya no queda ninguno) exigiria que la Inter no se cuele.
const CASOS = [
  { doc: 'cronograma-oscuro', tema: 'dark',  paginasMin: 2, v4: true,  gen: () => S.generateCronogramaPDF(L(LARGO), pays, true) },
  { doc: 'recibo-claro',      tema: 'light', paginasMin: 1, v4: true,  gen: () => S.generateRecibo(cuota(ID, 4), L(ID), 393610, 0, pays, { fechaRecaudo: '2026-08-14' }) },
  { doc: 'reporte-claro',     tema: 'light', paginasMin: 2, v4: true,  letrasExtra: ['SegoeUISymbol'], gen: () => S.generateReportePrestamosPDF(loans, pays, false) },
  // Con la app en tema oscuro: el documento v4 sale en el oscuro de la app.
  { doc: 'general-app-oscura', tema: 'dark', paginasMin: 2, v4: true,  gen: () => S.generateReciboGeneral(loans.filter(l => l.nombre === 'Bruno Salgado'), pays, '', { hasta: '2026-11-02' }) },
];
const LETRAS_V4 = ['Inter-Bold', 'Inter-Medium', 'Inter-Regular', 'Inter-SemiBold'];
const dir = path.join(WORK, `pdf-nativo-${process.pid}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
for (const c of CASOS) {
  tema(c.tema); CAP.pdfs.length = 0; c.gen();
  R.check(`${c.doc}: el generador emite exactamente 1 documento`, CAP.pdfs.length === 1, CAP.pdfs.length);
  if (CAP.pdfs.length) fs.writeFileSync(path.join(dir, c.doc + '.html'), CAP.pdfs[0].html);
}

// Sin ELECTRON_RUN_AS_NODE: el hijo arranca como app de Electron y puede crear ventanas.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const hijo = spawnSync(process.execPath, [__filename, '--app', dir], { env, encoding: 'utf8', timeout: 120000 });
const m = /@@RESULTADO@@(.*)@@FIN@@/.exec(hijo.stdout || '');
if (!R.check('el proceso Electron devolvio un resultado', !!m,
             `exit ${hijo.status}${hijo.error ? ' · ' + hijo.error.message : ''}\n` +
             String(hijo.stderr || '').split('\n').filter(l => !/ERROR:|DevTools/.test(l)).slice(-15).join('\n'))) {
  process.exit(R.finalizar());
}
const res = JSON.parse(m[1]);

R.eq('se imprimieron todos los documentos', res.docs.map(d => d.doc), CASOS.map(c => c.doc).sort());
for (const d of res.docs) {
  const c = CASOS.find(x => x.doc === d.doc) || {};
  R.eq(`${d.doc}: es un PDF`, d.cabecera, '%PDF-');
  R.check(`${d.doc}: tiene al menos ${c.paginasMin} pagina(s)`, d.paginas >= c.paginasMin, d.paginas);
  // Carta, como emitia 3.0.0: el cambio de ventana no puede cambiar el tamano del papel.
  R.eq(`${d.doc}: todas las paginas en tamano carta`, d.cajas, ['/MediaBox [0 0 612 792]']);
  R.check(`${d.doc}: no es un documento vacio (> 20 KB)`, d.bytes > 20000, d.bytes);
  // El margen de cada hoja, medido sobre el texto del PDF (ver la cabecera). 40 unidades son
  // ~1 cm: el marco deja 1,3 cm y la primera linea de texto cae un poco mas abajo. La hoja 2 de
  // un documento sin marco arrancaba a 0,2 pt del filo.
  const alt = d.alturas || [];
  R.check(`${d.doc}: cada hoja trae texto que medir`, alt.length === d.paginas && alt.every(Boolean), alt);
  const arriba = alt.map((a, i) => a ? Math.round(a.min - i * 1056) : null);
  const abajo  = alt.map((a, i) => a ? Math.round((i + 1) * 1056 - a.max) : null);
  R.check(`${d.doc}: cada hoja deja al menos 1 cm arriba`, arriba.every(v => v !== null && v >= 40), arriba);
  if (d.paginas > 1) {
    R.check(`${d.doc}: cada hoja que continua deja al menos 1 cm abajo`, abajo.slice(0, -1).every(v => v !== null && v >= 40), abajo);
  }
  R.eq(`${d.doc}: no deja la ventana oculta viva`, d.ventanasVivas, 0);
  const letras = d.letras || [];
  if (c.v4) {
    R.check(`${d.doc}: v4 — solo la Inter incrustada, en sus pesos fijos` + (c.letrasExtra ? ` (y ${c.letrasExtra.join(', ')}: sus glifos fuera de Inter)` : ''),
            letras.some(l => LETRAS_V4.indexOf(l) !== -1) &&
            letras.every(l => LETRAS_V4.indexOf(l) !== -1 || (c.letrasExtra || []).indexOf(l) !== -1), letras);
    R.check(`${d.doc}: v4 — sin fuentes Type 3 (la Inter variable)`, d.type3 === false, d.type3);
  } else {
    R.check(`${d.doc}: aun sin rediseñar — la letra de la app no se cuela`, letras.every(l => !/^Inter/.test(l)), letras);
  }
}
// La inyeccion de la letra, en si: va tras <head>, trae los 4 pesos en los 2 subconjuntos y deja
// el resto del documento intacto.
{
  const { conLetra } = require(path.join(DESKTOP, 'pdf.js'));
  const doc = '<!DOCTYPE html><html><head><title>x</title></head><body>hola</body></html>';
  const con = conLetra(doc);
  const caras = (con.match(/@font-face\{font-family:'Inter';font-style:normal;font-weight:(\d+);src:url\(data:font\/woff2;base64,/g) || []).length;
  R.eq('conLetra: 8 @font-face (4 pesos x 2 subconjuntos), incrustadas en base64', caras, 8);
  R.check('conLetra: la letra va justo despues de <head> y el resto queda igual',
          con.indexOf('<head><style>@font-face') !== -1 && con.replace(/<style>@font-face[\s\S]*?<\/style>/, '') === doc);
}
R.check('un documento que no se puede cargar rechaza la promesa', res.error && res.error.rechazo === true, res.error);
R.eq('un documento que no se puede cargar tampoco deja la ventana oculta viva', res.error && res.error.ventanasVivas, 0);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
process.exit(R.finalizar());
